"""Pydantic mirrors of the API response shapes (docs/api-contract.md, frontend/src/lib/manifest.ts).

Routes build plain dicts (so optional TypeScript fields are omitted, never sent as null, and nullable
fields are sent as null); these models document the shapes and validate them in tests. ``extra="forbid"``
catches keys the TypeScript types do not know, except where a model lists a deliberate live-only extra
(``FieldManifest.build``).
"""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict

TargetKind = Literal["high-pm-star", "brown-dwarf", "young-variable", "mira-variable", "bright-star"]
DetectorKey = Literal["D1", "D2", "D3", "D4", "D5", "D6"]
DetectorDigit = Literal["1", "2", "3", "4", "5", "6"]


class _Strict(BaseModel):
    model_config = ConfigDict(extra="forbid")


# --- FieldManifest (frontend/src/lib/manifest.ts) -------------------------------------------------------


class Fact(_Strict):
    label: str
    value: str


class TargetAstrometry(_Strict):
    ra: float
    dec: float
    ref_epoch: float
    pmra: float
    pmdec: float
    parallax: float | None = None
    rv: float | None = None
    source: str


class ManifestTarget(_Strict):
    key: str
    name: str
    kind: TargetKind
    aliases: list[str]
    simbad_id: str | None = None
    summary_plain: str
    facts: list[Fact]
    astrometry: TargetAstrometry


class Epoch(_Strict):
    index: int
    label: str
    survey: str
    year: int
    pa: float
    start: str
    end: str
    mjd_mid: float
    n_exposures: int
    detectors: dict[DetectorDigit, int]
    full: bool


class EpochFrame(_Strict):
    epoch: int
    url: str
    mjd: float
    n: int | None = None
    wl_um: tuple[float, float] | None = None
    channels: str | None = None


class ThenNowFrame(_Strict):
    label: str
    url: str
    mjd: float
    instrument: str


class DifferenceFrame(_Strict):
    detector: DetectorKey
    a: int
    b: int
    url: str
    units: Literal["sigma"]
    limits: tuple[float, float]


class FlagsFrame(_Strict):
    detector: DetectorKey
    epoch: int
    url: str
    legend: dict[str, str]


class Frames(_Strict):
    epoch: dict[Literal["D1", "D2", "D3", "D4", "D5", "D6", "rgb"], list[EpochFrame]]
    then_vs_now: list[ThenNowFrame]
    difference: list[DifferenceFrame]
    flags: list[FlagsFrame]


class Release(_Strict):
    collections: list[str]
    file_tags: list[str]
    latest_obs: str
    discovered_at: str | None = None


class Grid(_Strict):
    width: int
    height: int
    pixscale_arcsec: float
    wcs: dict[str, float | int | str]


class Center(_Strict):
    ra: float
    dec: float
    epoch_mjd: float


class Render(_Strict):
    stretch: str
    note: str | None = None


class Link(_Strict):
    label: str
    url: str


class BuildInfo(_Strict):
    """Live-only extra (not in manifest.ts): what one /api/field/build request did."""

    det: str
    modes: list[str]
    fov_arcmin: float
    n_images_available: int
    n_images_used: int
    n_images_failed: int
    n_images_skipped: int
    seconds: float
    requests: int
    bytes: int


class FieldManifest(_Strict):
    schema_: Literal["pxh-field/1"]
    generated_at: str
    source: Literal["bundle", "live", "fixture"]
    target: ManifestTarget | None
    center: Center
    fov_arcmin: float
    release: Release
    grid: Grid
    epochs: list[Epoch]
    frames: Frames
    render: Render | None = None
    motion: dict | None
    spectrum: dict | None
    lightcurve: dict | None
    checks: list[dict]
    warnings: list[str]
    links: list[Link]
    credits: str
    build: BuildInfo | None = None

    @classmethod
    def validate_manifest(cls, doc: dict) -> FieldManifest:
        """Validate a manifest dict (its "schema" key maps to ``schema_``)."""
        data = dict(doc)
        data["schema_"] = data.pop("schema")
        return cls.model_validate(data)


# --- other endpoints -------------------------------------------------------------------------------------


class Health(_Strict):
    status: Literal["ok"]
    version: str
    collections: list[str]
    collections_source: str
    uptime_s: float
    region: str | None = None


class TargetSummary(_Strict):
    key: str
    name: str
    kind: TargetKind
    ra: float
    dec: float
    summary_plain: str
    bundle: str


class Resolved(_Strict):
    query: str
    name: str
    ra: float
    dec: float
    epoch_mjd: float
    ra_j2000: float
    dec_j2000: float
    pmra: float
    pmdec: float
    parallax: float | None
    resolver: str
    target_key: str | None
    source: str


class ReleaseCollection(_Strict):
    name: str
    kind: Literal["l2", "l2-deep", "cube", "other"]
    latest_release: str | None
    n_rows_hint: int | None
    dataproduct_type: str | None
    calib_level: int | None


class Releases(_Strict):
    collections: list[ReleaseCollection]
    checked_at: str | None
    source: str


class FieldSummary(_Strict):
    schema_: Literal["pxh-field-summary/1"]
    generated_at: str
    center: dict[str, float]
    fov_arcmin: float
    epochs: list[Epoch]
    n_epochs: int
    n_images: int
    n_exposures: int
    collections: list[str]
    detectors: dict[DetectorKey, int]
    deep_field: bool
    release: Release
    warnings: list[str]


class QuickSpectrum(_Strict):
    wl_um: list[float]
    bw_um: list[float | None]
    flux_ujy: list[float | None]
    err_ujy: list[float | None]
    flux_partial_ujy: list[float | None]
    lower_limit: list[bool]
    label: str
    ra: float
    dec: float
    n_finite: int
    pixel_arcsec: float
    notes: str


class GaiaSource(_Strict):
    source_id: str
    ra: float
    dec: float
    g: float | None
    bp_rp: float | None
    pmra: float | None
    pmdec: float | None
    parallax: float | None


class WiseSource(_Strict):
    designation: str
    ra: float
    dec: float
    w1: float | None
    w2: float | None
    w1_err: float | None
    w2_err: float | None


class ApiError(_Strict):
    error: str
    message: str
    retryable: bool
    details: list | None = None
