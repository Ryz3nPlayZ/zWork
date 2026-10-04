import sqlite3


class Store:
    def __init__(self, cfg):
        # DB path comes from cfg["db_path"]; see config.load for env handling.
        self.conn = sqlite3.connect(cfg["db_path"])

    def purge(self, older_than_days):
        self.conn.execute("DELETE FROM events WHERE age_days > ?", (older_than_days,))

    def compact(self):
        self.conn.execute("VACUUM")
