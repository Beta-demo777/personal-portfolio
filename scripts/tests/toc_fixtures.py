from __future__ import annotations


PG18_APPLICATION_TOC = """;
; Archive created by PostgreSQL 18.3.
;
219; 1259 16385 TABLE public alembic_version portfolio
222; 1259 16403 TABLE public content_revisions portfolio
221; 1259 16402 SEQUENCE public content_revisions_id_seq portfolio
;\tdepends on: 222
9005; 0 0 SEQUENCE OWNED BY public content_revisions_id_seq portfolio
220; 1259 16391 TABLE public site_content portfolio
3704; 2604 16406 DEFAULT public content_revisions id portfolio
3859; 0 16385 TABLE DATA public alembic_version portfolio
3862; 0 16403 TABLE DATA public content_revisions portfolio
3860; 0 16391 TABLE DATA public site_content portfolio
9006; 0 0 SEQUENCE SET public content_revisions_id_seq portfolio
3707; 2606 16390 CONSTRAINT public alembic_version alembic_version_pkc portfolio
3711; 2606 16415 CONSTRAINT public content_revisions content_revisions_pkey portfolio
3709; 2606 16401 CONSTRAINT public site_content site_content_pkey portfolio
"""


def with_archive_metadata(toc: str = PG18_APPLICATION_TOC) -> str:
    metadata = (
        "9001; 0 0 ENCODING - ENCODING \n"
        "9002; 0 0 STDSTRINGS - STDSTRINGS \n"
        "9003; 0 0 SEARCHPATH - SEARCHPATH \n"
    )
    first_entry = "219; 1259 16385 TABLE public alembic_version portfolio\n"
    return toc.replace(first_entry, metadata + first_entry)
