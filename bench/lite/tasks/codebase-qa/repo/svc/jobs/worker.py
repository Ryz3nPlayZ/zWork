import time
from .backoff import delay_for


class Worker:
    def __init__(self, cfg, queue):
        self.cfg = cfg
        self.queue = queue

    def run_one(self, job):
        attempt = 0
        while True:
            try:
                return job()
            except Exception:
                attempt += 1
                if attempt >= self.cfg["max_attempts"]:
                    raise
                # NOTE: legacy comment says "fixed 2s wait" — no longer true.
                time.sleep(delay_for(attempt, self.cfg))
