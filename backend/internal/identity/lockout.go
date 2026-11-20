package identity

import (
	"context"
	"fmt"
	"github.com/redis/go-redis/v9"
)

// The Clock decides expiry; Redis performs each attempt's state transition
// atomically so concurrent attempts cannot lose failures or bypass a lock.
var signInAttempt = redis.NewScript(`
local untilAt = tonumber(redis.call('HGET', KEYS[1], 'until') or '0')
local now = tonumber(ARGV[1])
if untilAt > now then return -1 end
if untilAt > 0 then redis.call('DEL', KEYS[1]) end
if ARGV[2] == '1' then redis.call('DEL', KEYS[1]); return 0 end
local count = redis.call('HINCRBY', KEYS[1], 'failures', 1)
if count >= 5 then
 redis.call('HSET', KEYS[1], 'until', now + 900000)
 return 1
end
return 0
`)

func (s *Service) attempt(ctx context.Context, id int64, valid bool) (int, error) {
	v := 0
	if valid {
		v = 1
	}
	return signInAttempt.Run(ctx, s.sessions.redis, []string{fmt.Sprintf("signin:%d", id)}, s.clock.Now().UnixMilli(), v).Int()
}
