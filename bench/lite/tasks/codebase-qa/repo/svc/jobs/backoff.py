def delay_for(attempt, cfg):
    """Delay before retry number `attempt` (attempt 1 = first retry)."""
    raw = cfg["retry_base_seconds"] * (cfg["retry_factor"] ** (attempt - 1))
    return min(raw, cfg["retry_max_seconds"])
