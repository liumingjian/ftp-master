package identity

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"strconv"
	"time"

	"github.com/redis/go-redis/v9"

	"github.com/liumingjian/ftp-master/backend/internal/clock"
)

// IdleTimeout is how long a session survives without activity.
const IdleTimeout = 2 * time.Hour

// sessions keeps sign-in sessions in Redis, shared by every instance.
//
// A session is a hash under a key derived from its token, so a copy of Redis
// holds no usable tokens. Idle expiry is decided by the Clock against the
// stored last-activity time; the Redis TTL only removes abandoned sessions.
type sessions struct {
	redis *redis.Client
	clock clock.Clock
}

// touchIfPresent records activity on a session without resurrecting one that
// was revoked meanwhile.
var touchIfPresent = redis.NewScript(`
if redis.call('EXISTS', KEYS[1]) == 1 then
	redis.call('HSET', KEYS[1], 'last_active', ARGV[1])
	redis.call('PEXPIRE', KEYS[1], ARGV[2])
	return 1
end
return 0`)

// create starts a session for userID and returns its token.
func (s *sessions) create(ctx context.Context, userID, epoch int64) (string, error) {
	raw := make([]byte, 32)
	if _, err := rand.Read(raw); err != nil {
		return "", fmt.Errorf("generate session token: %w", err)
	}
	token := base64.RawURLEncoding.EncodeToString(raw)
	key := sessionKey(token)
	_, err := s.redis.TxPipelined(ctx, func(p redis.Pipeliner) error {
		p.HSet(ctx, key, "user_id", userID, "epoch", epoch, "last_active", s.clock.Now().UnixNano())
		p.PExpire(ctx, key, IdleTimeout)
		return nil
	})
	if err != nil {
		return "", fmt.Errorf("store session: %w", err)
	}
	return token, nil
}

// resolve returns the User a live session belongs to and extends its idle
// expiry. ok is false for an unknown, revoked or idle-expired session.
func (s *sessions) resolve(ctx context.Context, token string) (userID int64, epoch int64, ok bool, err error) {
	if token == "" {
		return 0, 0, false, nil
	}
	key := sessionKey(token)
	fields, err := s.redis.HGetAll(ctx, key).Result()
	if err != nil {
		return 0, 0, false, fmt.Errorf("read session: %w", err)
	}
	userID, idErr := strconv.ParseInt(fields["user_id"], 10, 64)
	epoch, epochErr := strconv.ParseInt(fields["epoch"], 10, 64)
	lastActive, timeErr := strconv.ParseInt(fields["last_active"], 10, 64)
	if idErr != nil || timeErr != nil || epochErr != nil {
		return 0, 0, false, nil
	}
	now := s.clock.Now()
	if now.Sub(time.Unix(0, lastActive)) >= IdleTimeout {
		if err := s.redis.Del(ctx, key).Err(); err != nil {
			return 0, 0, false, fmt.Errorf("remove expired session: %w", err)
		}
		return 0, 0, false, nil
	}
	touched, err := touchIfPresent.Run(ctx, s.redis, []string{key}, now.UnixNano(), IdleTimeout.Milliseconds()).Int()
	if err != nil {
		return 0, 0, false, fmt.Errorf("extend session: %w", err)
	}
	return userID, epoch, touched == 1, nil
}

// revoke ends a session immediately.
func (s *sessions) revoke(ctx context.Context, token string) error {
	if err := s.redis.Del(ctx, sessionKey(token)).Err(); err != nil && !errors.Is(err, redis.Nil) {
		return fmt.Errorf("revoke session: %w", err)
	}
	return nil
}

func sessionKey(token string) string {
	sum := sha256.Sum256([]byte(token))
	return "session:" + hex.EncodeToString(sum[:])
}
