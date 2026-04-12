FROM alpine:latest

# Install git, git-lfs, and node.js (HTTP-only server with LFS support)
RUN apk add --no-cache git git-lfs nodejs

# Create git user and repo directory
RUN adduser -D -h /home/git -s /bin/sh git && \
    mkdir -p /var/git/repos && \
    chown git:git /var/git/repos

# Copy entrypoint and HTTP server
COPY entrypoint.sh /usr/local/bin/entrypoint.sh
COPY http-server.js /usr/local/bin/http-server.js
RUN chmod +x /usr/local/bin/entrypoint.sh

USER git

EXPOSE 8000

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
