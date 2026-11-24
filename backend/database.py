import os

import psycopg
from psycopg.rows import dict_row


def connect():
    url = os.getenv("DATABASE_URL", "postgresql://swell:swell_local_dev@127.0.0.1:55436/poster_studio")
    return psycopg.connect(url, connect_timeout=5, row_factory=dict_row)
