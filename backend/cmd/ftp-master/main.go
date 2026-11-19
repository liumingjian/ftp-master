// Command ftp-master runs one stateless instance of the ftp-master service.
package main

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"syscall"
	"time"

	"github.com/liumingjian/ftp-master/backend/internal/app"
	"github.com/liumingjian/ftp-master/backend/internal/clock"
)

func main() {
	if err := run(); err != nil {
		slog.Error("ftp-master stopped", "error", err)
		os.Exit(1)
	}
}

func run() error {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	cfg := app.Config{
		DatabaseURL:    env("DATABASE_URL", "postgres://ftpmaster:ftpmaster@localhost:5432/ftpmaster?sslmode=disable"),
		RedisAddr:      env("REDIS_ADDR", "localhost:6379"),
		RedisPassword:  os.Getenv("REDIS_PASSWORD"),
		MinIOEndpoint:  env("MINIO_ENDPOINT", "localhost:9000"),
		MinIOAccessKey: env("MINIO_ACCESS_KEY", "ftpmaster"),
		MinIOSecretKey: env("MINIO_SECRET_KEY", "ftpmaster-secret"),
		MinIOUseSSL:    envBool("MINIO_USE_SSL"),
		MinIOBucket:    env("MINIO_BUCKET", "ftp-master"),
	}

	service, err := app.New(ctx, cfg, clock.System{})
	if err != nil {
		return err
	}
	defer service.Close()

	server := &http.Server{
		Addr:              env("LISTEN_ADDR", ":8080"),
		Handler:           service.Handler(),
		ReadHeaderTimeout: 10 * time.Second,
	}
	errs := make(chan error, 1)
	go func() {
		slog.Info("ftp-master listening", "addr", server.Addr)
		errs <- server.ListenAndServe()
	}()

	select {
	case err := <-errs:
		if !errors.Is(err, http.ErrServerClosed) {
			return err
		}
		return nil
	case <-ctx.Done():
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		return server.Shutdown(shutdownCtx)
	}
}

func env(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

func envBool(key string) bool {
	v, _ := strconv.ParseBool(os.Getenv(key))
	return v
}
