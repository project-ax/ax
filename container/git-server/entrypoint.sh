#!/bin/sh
set -e

mkdir -p /var/git/repos /var/git/lfs-objects

exec env PORT="${PORT:-8000}" GIT_REPOS_PATH="${GIT_REPOS_PATH:-/var/git/repos}" LFS_OBJECTS_PATH="${LFS_OBJECTS_PATH:-/var/git/lfs-objects}" node /usr/local/bin/http-server.js
