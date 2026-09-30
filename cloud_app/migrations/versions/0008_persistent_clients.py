"""Keep phone authorization until it is explicitly revoked."""
from alembic import op
import sqlalchemy as sa

revision = "0008_persistent_clients"
down_revision = "0007_client_versions"
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table("client_sessions") as batch:
        batch.alter_column("refresh_expires_at", existing_type=sa.Integer(), nullable=True)
    # Preserve identities and credential hashes, including interrupted renewals.
    # Never restore a phone that the owner or the old reuse detector revoked.
    op.execute("UPDATE client_sessions SET refresh_expires_at = NULL WHERE revoked_at IS NULL")


def downgrade() -> None:
    import time

    clients = sa.table("client_sessions", sa.column("refresh_expires_at", sa.Integer()))
    op.execute(clients.update().where(clients.c.refresh_expires_at.is_(None)).values(
        refresh_expires_at=int(time.time()) + 30 * 86400))
    with op.batch_alter_table("client_sessions") as batch:
        batch.alter_column("refresh_expires_at", existing_type=sa.Integer(), nullable=False)
