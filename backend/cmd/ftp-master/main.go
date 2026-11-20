// Command ftp-master runs one stateless instance of the ftp-master service.
package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"net/netip"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/liumingjian/ftp-master/backend/internal/app"
	"github.com/liumingjian/ftp-master/backend/internal/clock"
	"github.com/liumingjian/ftp-master/backend/internal/httpapi"
)

func main() {
	if err := run(); err != nil {
		slog.Error("ftp-master stopped", "error", err)
		os.Exit(1)
	}
}

func run() error {
	trustedProxies, err := parseTrustedProxies(os.Getenv("TRUSTED_PROXIES"))
	if err != nil {
		return err
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	cfg := app.Config{
		DatabaseURL:          env("DATABASE_URL", "postgres://ftp_master_app:ftp_master_app@localhost:5432/ftpmaster?sslmode=disable"),
		MigrationDatabaseURL: env("MIGRATION_DATABASE_URL", "postgres://ftpmaster:ftpmaster@localhost:5432/ftpmaster?sslmode=disable"),
		InitialAdministrator: app.InitialAdministrator{
			Username: os.Getenv("INITIAL_ADMINISTRATOR_USERNAME"),
			Password: os.Getenv("INITIAL_ADMINISTRATOR_PASSWORD"),
		},
		HTTP: httpapi.Options{
			TrustedProxies:        trustedProxies,
			InsecureSessionCookie: envBool("INSECURE_SESSION_COOKIE"),
		},
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
		//clock:wallclock grace period for in-flight requests, measured in real time
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

// parseTrustedProxies parses TRUSTED_PROXIES: a comma-separated list of
// addresses or CIDR prefixes.
func parseTrustedProxies(list string) ([]netip.Prefix, error) {
	var out []netip.Prefix
	for _, item := range strings.Split(list, ",") {
		item = strings.TrimSpace(item)
		if item == "" {
			continue
		}
		if !strings.Contains(item, "/") {
			addr, err := netip.ParseAddr(item)
			if err != nil {
				return nil, fmt.Errorf("TRUSTED_PROXIES: %w", err)
			}
			out = append(out, netip.PrefixFrom(addr, addr.BitLen()))
			continue
		}
		prefix, err := netip.ParsePrefix(item)
		if err != nil {
			return nil, fmt.Errorf("TRUSTED_PROXIES: %w", err)
		}
		out = append(out, prefix.Masked())
	}
	return out, nil
}
