package httpapi

import (
	"bytes"
	"context"
	"github.com/minio/minio-go/v7"
)

func (s *Server) rollbackImmutableObject(ctx context.Context, key string, committed *bool) func() {
	return func() {
		if !*committed {
			_ = s.transfer.Client.RemoveObject(context.WithoutCancel(ctx), s.transfer.Bucket, key, minio.RemoveObjectOptions{})
		}
	}
}
func (s *Server) writeImmutableObject(ctx context.Context, key string, data []byte, contentType string) error {
	_, err := s.transfer.Client.PutObject(ctx, s.transfer.Bucket, key, bytes.NewReader(data), int64(len(data)), minio.PutObjectOptions{ContentType: contentType})
	return err
}
