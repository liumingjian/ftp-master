//go:build integration

package app_test

import (
	"context"
	"net/url"
	"path/filepath"
	"strings"
	"testing"

	"github.com/testcontainers/testcontainers-go"
	"github.com/testcontainers/testcontainers-go/modules/minio"
	"github.com/testcontainers/testcontainers-go/modules/postgres"
	"github.com/testcontainers/testcontainers-go/modules/redis"

	"github.com/liumingjian/ftp-master/backend/internal/app"
)

// Image versions match deploy/local/docker-compose.yml.
const (
	postgresImage = "postgres:17-alpine"
	redisImage    = "redis:7-alpine"
	minioImage    = "pgsty/minio:RELEASE.2026-08-04T00-00-00Z"
)

// The Administrator every test service creates on its first start.
const (
	initialAdministratorUsername = "admin"
	initialAdministratorPassword = "correct horse battery staple"
)

// applicationRoleScript creates the login role the service connects as; the
// local stack runs the same script.
var applicationRoleScript = filepath.Join("..", "..", "..", "deploy", "local", "postgres", "10-application-role.sql")

// stores are real, empty PostgreSQL, MinIO and Redis instances for one test.
type stores struct {
	config app.Config
	redis  testcontainers.Container
}

func startStores(t *testing.T) stores {
	t.Helper()
	ctx := context.Background()

	pg, err := postgres.Run(ctx, postgresImage,
		postgres.WithDatabase("ftpmaster"),
		postgres.WithUsername("ftpmaster"),
		postgres.WithPassword("ftpmaster"),
		postgres.WithInitScripts(applicationRoleScript),
		postgres.BasicWaitStrategies(),
	)
	testcontainers.CleanupContainer(t, pg)
	if err != nil {
		t.Fatalf("start PostgreSQL: %v", err)
	}
	ownerURL, err := pg.ConnectionString(ctx, "sslmode=disable")
	if err != nil {
		t.Fatal(err)
	}
	applicationURL, err := url.Parse(ownerURL)
	if err != nil {
		t.Fatal(err)
	}
	applicationURL.User = url.UserPassword("ftp_master_app", "ftp_master_app")

	rd, err := redis.Run(ctx, redisImage)
	testcontainers.CleanupContainer(t, rd)
	if err != nil {
		t.Fatalf("start Redis: %v", err)
	}
	redisURL, err := rd.ConnectionString(ctx)
	if err != nil {
		t.Fatal(err)
	}

	mn, err := minio.Run(ctx, minioImage, minio.WithUsername("ftpmaster"), minio.WithPassword("ftpmaster-secret"))
	testcontainers.CleanupContainer(t, mn)
	if err != nil {
		t.Fatalf("start MinIO: %v", err)
	}
	minioEndpoint, err := mn.ConnectionString(ctx)
	if err != nil {
		t.Fatal(err)
	}

	return stores{
		config: app.Config{
			DatabaseURL:          applicationURL.String(),
			MigrationDatabaseURL: ownerURL,
			InitialAdministrator: app.InitialAdministrator{
				Username: initialAdministratorUsername,
				Password: initialAdministratorPassword,
			},
			RedisAddr:      strings.TrimPrefix(redisURL, "redis://"),
			MinIOEndpoint:  minioEndpoint,
			MinIOAccessKey: "ftpmaster",
			MinIOSecretKey: "ftpmaster-secret",
			MinIOBucket:    "ftp-master",
		},
		redis: rd,
	}
}
