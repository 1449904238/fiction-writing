#!/usr/bin/env python3
"""Aggregate independent blind quality reviews without fabricating missing data."""

from __future__ import annotations

import argparse
import json
from collections import defaultdict
from pathlib import Path
from statistics import mean
from typing import Any


DIMENSIONS = ("causal_pressure", "character_necessity", "opponent_agency", "genre_delivery", "reveal_payoff", "continue_pull")


def load_reviews(directory: Path) -> tuple[list[dict[str, Any]], list[str]]:
    reviews: list[dict[str, Any]] = []
    errors: list[str] = []
    for path in sorted(directory.glob("*.json")):
        try:
            item = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            errors.append(f"{path.name}: {exc}")
            continue
        if not isinstance(item, dict):
            errors.append(f"{path.name}: review must be an object")
            continue
        required = {"review_id", "case_id", "reviewer_id", "genre", "scores", "would_continue"}
        missing = required - set(item)
        if missing:
            errors.append(f"{path.name}: missing {sorted(missing)}")
            continue
        scores = item.get("scores")
        if not isinstance(scores, dict) or set(scores) != set(DIMENSIONS):
            errors.append(f"{path.name}: scores must contain exactly {DIMENSIONS}")
            continue
        if any(not isinstance(scores[key], int) or not 0 <= scores[key] <= 4 for key in DIMENSIONS):
            errors.append(f"{path.name}: scores must be integers from 0 to 4")
            continue
        if "generator" in item or "model" in item or "source_prompt" in item:
            errors.append(f"{path.name}: blind review must not disclose generator metadata")
            continue
        reviews.append(item)
    return reviews, errors


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("reviews", type=Path)
    parser.add_argument("--min-reviewers", type=int, default=2)
    parser.add_argument("--report", type=Path)
    args = parser.parse_args()
    reviews, errors = load_reviews(args.reviews)
    by_case: dict[str, list[dict[str, Any]]] = defaultdict(list)
    by_genre: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for review in reviews:
        by_case[review["case_id"]].append(review)
        by_genre[review["genre"]].append(review)
    case_reports = {}
    for case_id, items in sorted(by_case.items()):
        complete = len({item["reviewer_id"] for item in items}) >= args.min_reviewers
        scores = [mean(item["scores"].values()) for item in items]
        case_reports[case_id] = {
            "reviewers": len({item["reviewer_id"] for item in items}),
            "quality_score": round(mean(scores) / 4 * 100, 2) if complete else "unmeasured",
            "score_spread": round(max(scores) - min(scores), 3) if len(scores) > 1 else "unmeasured",
            "would_continue_rate": round(sum(bool(item["would_continue"]) for item in items) / len(items), 3) if complete else "unmeasured",
        }
    genre_reports = {}
    for genre, items in sorted(by_genre.items()):
        complete_scores = [mean(item["scores"].values()) / 4 * 100 for item in items if len({r["reviewer_id"] for r in by_case[item["case_id"]]}) >= args.min_reviewers]
        genre_reports[genre] = {"cases": len({item["case_id"] for item in items}), "quality_score": round(mean(complete_scores), 2) if complete_scores else "unmeasured"}
    report = {
        "review_count": len(reviews),
        "errors": errors,
        "case_reports": case_reports,
        "genre_reports": genre_reports,
        "note": "Quality is unmeasured for cases with fewer than the configured independent reviewers.",
    }
    rendered = json.dumps(report, ensure_ascii=False, indent=2)
    if args.report:
        args.report.write_text(rendered + "\n", encoding="utf-8")
    print(rendered)
    return 0 if not errors else 1


if __name__ == "__main__":
    raise SystemExit(main())
