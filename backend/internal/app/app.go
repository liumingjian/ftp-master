// Package app assembles the service: it connects the backing stores, applies
// migrations and builds the HTTP handler. main and the integration tests both
// start the service through New, so tests exercise the real wiring.
package app

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/minio/minio-go/v7"
	"github.com/minio/minio-go/v7/pkg/credentials"
	"github.com/redis/go-redis/v9"

	"github.com/liumingjian/ftp-master/backend/internal/audit"
	"github.com/liumingjian/ftp-master/backend/internal/clock"
	"github.com/liumingjian/ftp-master/backend/internal/db"
	"github.com/liumingjian/ftp-master/backend/internal/db/sqlcdb"
	"github.com/liumingjian/ftp-master/backend/internal/health"
	"github.com/liumingjian/ftp-master/backend/internal/httpapi"
	"github.com/liumingjian/ftp-master/backend/internal/identity"
)

// Config locates the backing stores and sets up the first sign-in.
type Config struct {
	// DatabaseURL connects as the application role (ftp_master_app), which
	// owns nothing and holds only the privileges the migrations grant it.
	DatabaseURL string
	// MigrationDatabaseURL connects as the schema owner; it is used only to
	// apply migrations at startup.
	MigrationDatabaseURL string

	// InitialAdministrator is created on startup while no Administrator
	// exists; leave it empty once the installation has one.
	InitialAdministrator InitialAdministrator

	// HTTP adjusts how the API treats the network in front of it.
	HTTP httpapi.Options

	RedisAddr     string
	RedisPassword string

	MinIOEndpoint  string
	MinIOAccessKey string
	MinIOSecretKey string
	MinIOUseSSL    bool
	MinIOBucket    string
}

// InitialAdministrator are the credentials of the first Administrator.
type InitialAdministrator struct {
	Username string
	Password string
}

// App is a running service instance.
type App struct {
	pool    *pgxpool.Pool
	redis   *redis.Client
	handler http.Handler
}

// New applies pending migrations, connects to the backing stores, ensures the
// content bucket, the current Audit partitions and the initial Administrator
// exist, and builds the HTTP handler.
func New(ctx context.Context, cfg Config, clk clock.Clock) (_ *App, err error) {
	if err := migrate(ctx, cfg.MigrationDatabaseURL); err != nil {
		return nil, err
	}
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

	queries := sqlcdb.New(pool)
	recorder := audit.NewRecorder(queries, clk)
	// This month's and next month's partitions, so the first events of a
	// month do not race to create one.
	now := clk.Now()
	for _, month := range []time.Time{now, now.AddDate(0, 1, 0)} {
		if err := recorder.EnsurePartition(ctx, month); err != nil {
			return nil, err
		}
	}
	identityService, err := identity.NewService(queries, redisClient, recorder, clk)
	if err != nil {
		return nil, err
	}
	initial := cfg.InitialAdministrator
	if err := identityService.EnsureInitialAdministrator(ctx, initial.Username, initial.Password); err != nil {
		return nil, err
	}

	checker := health.NewChecker(clk,
		queries,
		bucketPinger{client: minioClient, bucket: cfg.MinIOBucket},
		redisPinger{client: redisClient},
	)
	handler, err := httpapi.NewHandler(checker, identityService, cfg.HTTP)
	if err != nil {
		return nil, err
	}
	return &App{pool: pool, redis: redisClient, handler: handler}, nil
}

// migrate applies pending migrations as the schema owner, over a connection
// used for nothing else.
func migrate(ctx context.Context, databaseURL string) error {
	if databaseURL == "" {
		return errors.New("no migration database URL configured")
	}
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		return fmt.Errorf("connect to PostgreSQL as schema owner: %w", err)
	}
	defer pool.Close()
	return db.Migrate(ctx, pool)
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
