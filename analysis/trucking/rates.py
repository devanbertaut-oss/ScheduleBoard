"""Authoritative rate structure for Three C's trucking on DPW547 (Job 2124013).

Single source of truth for the rate audit and unit derivation. Any rate observed
in the tracker that is not explained by these tables is either a KNOWN_EXCEPTION
(legacy tax-inclusive display rates from the old rate-card image), a
NEW_RATE_ALERT (first appearance of a genuinely new rate, e.g. $47 washed
limestone in Jun 2026), or a MISMATCH requiring review.
"""

# ---- Trucking rates (CC = T, never taxed) ----
HOURLY_RATES = {105.00: "triaxle", 120.00: "quadaxle"}

# Haul rates keyed by rate -> (unit, what it is). $10.00 is ambiguous between
# dirt haul-out (CY) and crushed concrete (TN) — the classifier disambiguates
# on description keywords.
HAUL_RATES = {
    8.50: ("CY", "sand haul"),
    7.50: ("TN", "limestone haul"),
    10.00: (None, "dirt haul-out (CY) or crushed concrete (TN)"),
    15.50: ("TN", "contaminated haul (River Birch)"),
}

DUMP_RATES = {
    6.05: ("CY", "Gentilly landfill dump fee"),
    42.00: ("TN", "River Birch disposal fee"),
}

# ---- Material rates (CC = M, always taxed at 9.45%; column H embeds tax) ----
TAX = 1.0945
MATERIAL_RATES = {
    5.50: ("CY", "Sand from Wood EB"),
    42.00: ("TN", "610 Limestone (PMC or Wood)"),
    44.00: ("TN", "57 Limestone (PMC, Vulcan, Five-S)"),
    54.45: ("TN", "57 Limestone from Wood EB (premium source — flag)"),
    22.00: ("TN", "610 Crushed Concrete (PMC or Wood)"),
    47.00: ("TN", "#8 Washed Limestone from Wood (new Jun 2026)"),
}

# Legacy tax-inclusive display rates from the old rate-card image, plus
# odd-lot materials confirmed present in the tracker. Clean exceptions, not
# errors — but each occurrence is still listed on the Rate Audit tab.
KNOWN_EXCEPTION_RATES = {46.20, 47.85, 48.95, 49.50, 51.70, 54.45}

# Overhead / non-production codes: never allowed to win a production truck's
# allocation without a manual flag.
OVERHEAD_CODES = {"99.12.00.00", "99.13.00.00", "02.41.91.00"}

# Financially contested arch-pipe code family — every assignment surfaced,
# never silently aggregated (51"x31" vs 44"x27" classification issue at
# Orange Street).
ARCH_PIPE_PREFIX = "33.40.19."

# Reconciliation target across the 31 invoices in the tracker.
EXPECTED_TOTAL = 2_030_890.67
EXPECTED_INVOICES = 31
RECON_TOLERANCE = 0.05

# Invoice-number era boundaries (two tracker gaps: Feb–mid-Mar 2025 and
# Aug 2025 → Mar 2026). Trailing statistics must never cross an era boundary.
ERAS = [
    (72919, 73099),  # era 1: Jan 2025
    (73853, 75313),  # era 2: late Mar – Aug 2025
    (77857, 78829),  # era 3: Mar – Jun 2026
]


def era_of(inv: int):
    for i, (lo, hi) in enumerate(ERAS, start=1):
        if lo <= inv <= hi:
            return i
    return None
