# 官方社区镜像已停止分发，固定原版本源码与校验值，避免依赖失效仓库或第三方镜像。
FROM golang:1.26-alpine AS build
WORKDIR /src
ADD --checksum=sha256:f31b6997fdb098479ddddfca1267f02518ee0b59cc1d3f9682c3a48e6309f4d0 https://codeload.github.com/minio/minio/tar.gz/7ced9663e6a791fef9dc6be798ff24cda9c730ac /tmp/minio.tar.gz
RUN tar -xzf /tmp/minio.tar.gz --strip-components=1 && rm /tmp/minio.tar.gz
RUN --mount=type=cache,target=/go/pkg/mod --mount=type=cache,target=/root/.cache/go-build \
    CGO_ENABLED=0 go build -trimpath -ldflags="-s -w -X github.com/minio/minio/cmd.Version=2025-07-23T15:54:02Z -X github.com/minio/minio/cmd.ReleaseTag=RELEASE.2025-07-23T15-54-02Z -X github.com/minio/minio/cmd.CommitID=7ced9663e6a791fef9dc6be798ff24cda9c730ac -X github.com/minio/minio/cmd.CopyrightYear=2025" -o /minio .

FROM alpine:3.22
RUN apk add --no-cache ca-certificates curl
COPY --from=build /minio /usr/local/bin/minio
COPY --from=build /src/LICENSE /src/CREDITS /licenses/
EXPOSE 9000 9001
ENTRYPOINT ["minio"]
