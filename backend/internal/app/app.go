// Package app assembles the service: it connects the backing stores, applies
// migrations and builds the HTTP handler. main and the integration tests both
// start the service through New, so tests exercise the real wiring.
package app

import (
	"context"
	"errors"
	"fmt"
	"net/http"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/minio/minio-go/v7"
	"github.com/minio/minio-go/v7/pkg/credentials"
	"github.com/redis/go-redis/v9"

	"github.com/liumingjian/ftp-master/backend/internal/clock"
	"github.com/liumingjian/ftp-master/backend/internal/db"
	"github.com/liumingjian/ftp-master/backend/internal/db/sqlcdb"
	"github.com/liumingjian/ftp-master/backend/internal/health"
	"github.com/liumingjian/ftp-master/backend/internal/httpapi"
)

// Config locates the backing stores.
type Config struct {
	DatabaseURL string

	RedisAddr     string
	RedisPassword string

	MinIOEndpoint  string
	MinIOAccessKey string
	MinIOSecretKey string
	MinIOUseSSL    bool
	MinIOBucket    string
}

// App is a running service instance.
type App struct {
	pool    *pgxpool.Pool
	redis   *redis.Client
	handler http.Handler
}

// New connects to the backing stores, applies pending migrations, ensures the
// content bucket exists and builds the HTTP handler.
func New(ctx context.Context, cfg Config, clk clock.Clock) (_ *App, err error) {
	pool, err := pgxpool.New(ctx, cfg.DatabaseURL)
	if err != nil {
		return nil, fmt.Errorf("connect to PostgreSQL: %w", err)
	}
	redisClient := redis.NewClient(&redis.Options{Addr: cfg.RedisAddr, Password: cfg.RedisPassword})
	defer func() {
		if err != nil {
			pool.Close()
			_ = redisClient.Close()
		}
	}()

	if err := db.Migrate(ctx, pool); err != nil {
		return nil, err
	}

	minioClient, err := minio.New(cfg.MinIOEndpoint, &minio.Options{
		Creds:  credentials.NewStaticV4(cfg.MinIOAccessKey, cfg.MinIOSecretKey, ""),
		Secure: cfg.MinIOUseSSL,
	})
	if err != nil {
		return nil, fmt.Errorf("configure MinIO client: %w", err)
	}
	if err := ensureBucket(ctx, minioClient, cfg.MinIOBucket); err != nil {
		return nil, err
	}

	checker := health.NewChecker(clk,
		sqlcdb.New(pool),
		bucketPinger{client: minioClient, bucket: cfg.MinIOBucket},
		redisPinger{client: redisClient},
	)
	return &App{
		pool:    pool,
		redis:   redisClient,
		handler: httpapi.NewHandler(checker),
	}, nil
}

// Handler serves the HTTP API.
func (a *App) Handler() http.Handler { return a.handler }

// Close releases connections to the backing stores.
func (a *App) Close() {
	a.pool.Close()
	_ = a.redis.Close()
}

func ensureBucket(ctx context.Context, client *minio.Client, bucket string) error {
	exists, err := client.BucketExists(ctx, bucket)
	if err != nil {
		return fmt.Errorf("check MinIO bucket %q: %w", bucket, err)
	}
	if exists {
		return nil
	}
	if err := client.MakeBucket(ctx, bucket, minio.MakeBucketOptions{}); err != nil {
		return fmt.Errorf("create MinIO bucket %q: %w", bucket, err)
	}
	return nil
}

type bucketPinger struct {
	client *minio.Client
	bucket string
}

func (p bucketPinger) Ping(ctx context.Context) error {
	exists, err := p.client.BucketExists(ctx, p.bucket)
	if err != nil {
		return err
	}
	if !exists {
		return errors.New("bucket " + p.bucket + " does not exist")
	}
	return nil
}

type redisPinger struct{ client *redis.Client }

func (p redisPinger) Ping(ctx context.Context) error { return p.client.Ping(ctx).Err() }
