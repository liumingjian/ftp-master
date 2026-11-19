# Build context: the repository root (the contract lives in api/).
FROM golang:1.26-alpine AS build
WORKDIR /src/backend
COPY backend/go.mod backend/go.sum ./
RUN go mod download
COPY api/ /src/api/
COPY backend/ ./
# A contract changed without regenerating fails the image build. (sqlc needs
# cgo, which this image lacks; `sqlc diff` runs in CI and `make check-generated`.)
RUN go test ./internal/api/
RUN CGO_ENABLED=0 go build -trimpath -o /out/ftp-master ./cmd/ftp-master

FROM alpine:3.22
RUN adduser -D -H ftpmaster
USER ftpmaster
COPY --from=build /out/ftp-master /usr/local/bin/ftp-master
EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/ftp-master"]
