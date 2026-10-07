import os

DEFAULTS = {
    "retry_base_seconds": 1.5,
    "retry_factor": 3,
    "retry_max_seconds": 30,
    "max_attempts": 5,
    "db_path": "data/app.db",
}


def load(overrides=None):
    cfg = dict(DEFAULTS)
    cfg.update(overrides or {})
    env_db = os.environ.get("SVC_STORE_PATH") or os.environ.get("APP_DB")
    if env_db:
        cfg["db_path"] = env_db
    return cfg
