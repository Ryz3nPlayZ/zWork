from . import handlers

ROUTES = [
    ("GET", "/health", handlers.health),
    ("POST", "/admin/compact", handlers.compact),
    ("DELETE", "/admin/events", handlers.cleanup_events),
    ("POST", "/admin/purge", handlers.purge_cache),
]
