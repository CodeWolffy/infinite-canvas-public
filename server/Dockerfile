FROM golang:1.26-alpine AS build
WORKDIR /src
COPY server/go.mod server/go.sum ./
RUN go mod download
COPY server/ ./
RUN CGO_ENABLED=0 go build -trimpath -o /canvas-server .

FROM alpine:3.22
RUN apk add --no-cache ca-certificates tzdata ffmpeg && addgroup -S canvas && adduser -S -G canvas canvas
COPY --from=build /canvas-server /usr/local/bin/canvas-server
USER canvas
EXPOSE 3001
ENTRYPOINT ["canvas-server"]
