from alembic import context
from geoalchemy2 import alembic_helpers
from sqlalchemy import create_engine, pool

from airlayer.config import get_settings
from airlayer.models import Base


def include_object(
    obj: object, name: str | None, type_: str, reflected: bool, compare_to: object
) -> bool:
    # Autogenerate must only ever touch tables our models define. The database also holds
    # PostGIS extension tables and Procrastinate's tables; treating them as "removed" would
    # generate drops for them.
    if type_ == "table" and reflected and compare_to is None:
        return False
    return alembic_helpers.include_object(obj, name, type_, reflected, compare_to)


def run() -> None:
    engine = create_engine(get_settings().sqlalchemy_url, poolclass=pool.NullPool)
    with engine.connect() as connection:
        context.configure(
            connection=connection,
            target_metadata=Base.metadata,
            include_object=include_object,
            process_revision_directives=alembic_helpers.writer,
            render_item=alembic_helpers.render_item,
        )
        with context.begin_transaction():
            context.run_migrations()


run()
