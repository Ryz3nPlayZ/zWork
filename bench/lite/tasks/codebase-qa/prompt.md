I'm trying to understand this service before changing it. Answer these by reading the code, and write the answers to `answers.json` as {"q1": ..., "q2": ..., "q3": ...}:

q1: When a job fails, how many seconds does the worker wait before the THIRD retry attempt, with the default config? (number)
q2: Which environment variable, if set, overrides the store's database path? (string, exact name)
q3: Which HTTP route (method + path, e.g. "GET /foo") ends up calling `Store.purge`? (string)
