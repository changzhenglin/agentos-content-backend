-- Fold-11：postgres image 默认只建 POSTGRES_DB（agentos_content）一个 DB。
-- 本 init 脚本在 postgres 首次启动时自动建 IAM + ops 两个 DB，
-- 使三 service 共享同一 postgres 实例、各自独立 DB。
-- 挂载点：/docker-entrypoint-initdb.d/（postgres 官方 image 首次启动自动执行）。
CREATE DATABASE agentos_iam;
CREATE DATABASE agentos_ops;
