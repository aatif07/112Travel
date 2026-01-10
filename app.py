# app.py
from __future__ import annotations

import os
import json
import numpy as np
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

from flask import Flask, jsonify, render_template, request
from flask_sqlalchemy import SQLAlchemy
from sqlalchemy import Integer, String, Date, DateTime, Text
from sqlalchemy.orm import Mapped, mapped_column
from sqlalchemy.types import JSON as SA_JSON

from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.metrics.pairwise import cosine_similarity


# ------------------------------------------------------------------------------
# App / DB setup
# ------------------------------------------------------------------------------
BASE_DIR = os.path.dirname(os.path.abspath(__file__))

app = Flask(__name__)
app.config["SQLALCHEMY_DATABASE_URI"] = "sqlite:///" + os.path.join(BASE_DIR, "travel.db")
app.config["SQLALCHEMY_TRACK_MODIFICATIONS"] = False

db = SQLAlchemy(app)


# ------------------------------------------------------------------------------
# Models
# ------------------------------------------------------------------------------
class AppState(db.Model):
    __tablename__ = "app_state"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    visited: Mapped[List[str]] = mapped_column(SA_JSON, default=list, nullable=False)
    planned: Mapped[List[str]] = mapped_column(SA_JSON, default=list, nullable=False)

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=lambda: datetime.now(timezone.utc),
        nullable=False,
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=lambda: datetime.now(timezone.utc),
        onupdate=lambda: datetime.now(timezone.utc),
        nullable=False,
    )


class Trip(db.Model):
    __tablename__ = "trip"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)

    country: Mapped[str] = mapped_column(String(120), nullable=False)
    start_date: Mapped[Optional[datetime]] = mapped_column(Date, nullable=True)
    end_date: Mapped[Optional[datetime]] = mapped_column(Date, nullable=True)

    cities: Mapped[List[str]] = mapped_column(SA_JSON, default=list, nullable=False)
    companions: Mapped[List[str]] = mapped_column(SA_JSON, default=list, nullable=False)
    notes: Mapped[str] = mapped_column(Text, default="", nullable=False)

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=lambda: datetime.now(timezone.utc),
        nullable=False,
    )


# ------------------------------------------------------------------------------
# Helpers
# ------------------------------------------------------------------------------
def _ensure_state_row() -> AppState:
    """
    Ensure we always have a single AppState row with id=1.
    """
    s = AppState.query.get(1)
    if not s:
        s = AppState(id=1, visited=[], planned=[])
        db.session.add(s)
        db.session.commit()
    return s


def _parse_date_yyyy_mm_dd(value: Optional[str]) -> Optional[datetime.date]:
    if not value:
        return None
    return datetime.strptime(value, "%Y-%m-%d").date()


def _uniq_sorted(values: List[str]) -> List[str]:
    return sorted({(v or "").strip() for v in values if (v or "").strip()})


def _load_country_city_catalog() -> Dict[str, List[str]]:
    """
    static/data/country_cities.json
    {
      "Spain": ["Granada", "Seville", ...],
      ...
    }
    """
    path = os.path.join(app.root_path, "static", "data", "country_cities.json")
    if not os.path.exists(path):
        return {}
    with open(path, "r", encoding="utf-8") as f:
        data = json.load(f)
    # normalise
    out: Dict[str, List[str]] = {}
    for k, v in (data or {}).items():
        if isinstance(k, str) and isinstance(v, list):
            out[k.strip()] = _uniq_sorted([str(x) for x in v])
    return out


# ------------------------------------------------------------------------------
# Pages
# ------------------------------------------------------------------------------
@app.get("/")
def home_page():
    return render_template("index.html")


@app.get("/suggestions")
def suggestions_page():
    return render_template("suggestions.html")


# ------------------------------------------------------------------------------
# API: State
# ------------------------------------------------------------------------------
@app.get("/api/state")
def api_get_state():
    s = _ensure_state_row()
    trips = Trip.query.order_by(Trip.created_at.desc()).all()

    return jsonify(
        {
            "visited": s.visited or [],
            "planned": s.planned or [],
            "trips": [
                {
                    "id": t.id,
                    "country": t.country,
                    "start_date": t.start_date.isoformat() if t.start_date else None,
                    "end_date": t.end_date.isoformat() if t.end_date else None,
                    "cities": t.cities or [],
                    "companions": t.companions or [],
                    "notes": t.notes or "",
                    "created_at": t.created_at.isoformat(),
                }
                for t in trips
            ],
        }
    )


@app.post("/api/state")
def api_set_state():
    payload = request.get_json(silent=True) or {}
    visited = payload.get("visited", [])
    planned = payload.get("planned", [])

    if not isinstance(visited, list) or not isinstance(planned, list):
        return jsonify({"ok": False, "error": "visited/planned must be lists"}), 400

    s = _ensure_state_row()
    s.visited = _uniq_sorted([str(x) for x in visited])
    s.planned = _uniq_sorted([str(x) for x in planned])
    db.session.commit()

    return jsonify({"ok": True, "visited": s.visited, "planned": s.planned})


# ------------------------------------------------------------------------------
# API: Trips
# ------------------------------------------------------------------------------
@app.post("/api/trips")
def api_add_trip():
    payload = request.get_json(silent=True) or {}

    country = (payload.get("country") or "").strip()
    if not country:
        return jsonify({"ok": False, "error": "country is required"}), 400

    start_date = _parse_date_yyyy_mm_dd(payload.get("start_date"))
    end_date = _parse_date_yyyy_mm_dd(payload.get("end_date"))

    cities = payload.get("cities", [])
    companions = payload.get("companions", [])
    notes = (payload.get("notes") or "").strip()

    if not isinstance(cities, list) or not isinstance(companions, list):
        return jsonify({"ok": False, "error": "cities/companions must be lists"}), 400

    t = Trip(
        country=country,
        start_date=start_date,
        end_date=end_date,
        cities=_uniq_sorted([str(x) for x in cities]),
        companions=_uniq_sorted([str(x) for x in companions]),
        notes=notes,
    )
    db.session.add(t)
    db.session.commit()

    # Optional: auto-add to visited when a trip is added
    s = _ensure_state_row()
    if country not in (s.visited or []):
        s.visited = _uniq_sorted((s.visited or []) + [country])
        # remove from planned if present
        s.planned = [c for c in (s.planned or []) if c != country]
        db.session.commit()

    return jsonify({"ok": True, "trip_id": t.id})


@app.delete("/api/trips/<int:trip_id>")
def api_delete_trip(trip_id: int):
    t = Trip.query.get(trip_id)
    if not t:
        return jsonify({"ok": False, "error": "trip not found"}), 404

    db.session.delete(t)
    db.session.commit()
    return jsonify({"ok": True})


# ------------------------------------------------------------------------------
# API: Suggestions (Tier 1 ML - TF-IDF similarity)
# ------------------------------------------------------------------------------
@app.get("/api/suggestions")
def api_suggestions():
    s = _ensure_state_row()
    planned = s.planned or []

    trips = Trip.query.order_by(Trip.created_at.desc()).all()

    # Build preference corpus from visited trips (country + cities + notes + companions)
    visited_docs: List[str] = []
    for t in trips:
        doc = " ".join(
            [
                (t.country or "").strip(),
                " ".join(t.cities or []),
                (t.notes or "").strip(),
                " ".join(t.companions or []),
            ]
        ).strip()
        if doc:
            visited_docs.append(doc)

    # Load local city catalog
    country_cities = _load_country_city_catalog()
    if not country_cities:
        return jsonify(
            {
                "ok": False,
                "error": "Missing or empty static/data/country_cities.json",
            }
        ), 400

    # Build candidates from planned countries
    candidates: List[Dict[str, Any]] = []
    for country in planned:
        for city in country_cities.get(country, []):
            candidates.append({"country": country, "city": city, "doc": f"{country} {city}"})

    if not candidates:
        return jsonify(
            {
                "ok": True,
                "suggestions": {},
                "note": "No candidates found for your planned countries. Add cities in static/data/country_cities.json.",
            }
        )

    # If no travel history yet, fallback to a simple list (no ML signal)
    if not visited_docs:
        out: Dict[str, List[Dict[str, Any]]] = {}
        for c in candidates:
            out.setdefault(c["country"], []).append(
                {
                    "city": c["city"],
                    "score": 0.10,
                    "reason": "No past trips yet — showing starter cities.",
                }
            )
        # cap
        for k in out:
            out[k] = out[k][:8]
        return jsonify({"ok": True, "suggestions": out})

    # TF-IDF similarity between preference profile and candidate docs
    candidate_docs = [c["doc"] for c in candidates]
    all_docs = visited_docs + candidate_docs

    vectorizer = TfidfVectorizer(stop_words="english", ngram_range=(1, 2), max_features=6000)
    X = vectorizer.fit_transform(all_docs)

    visited_vecs = X[: len(visited_docs)]
    cand_vecs = X[len(visited_docs) :]

    pref_vec = np.asarray(visited_vecs.mean(axis=0))  # convert np.matrix -> ndarray
    sims = cosine_similarity(cand_vecs, pref_vec).reshape(-1)

    # Build output: top per country
    scored = list(zip(candidates, sims))
    scored.sort(key=lambda x: x[1], reverse=True)

    out: Dict[str, List[Dict[str, Any]]] = {}
    for c, score in scored:
        country = c["country"]
        if country not in out:
            out[country] = []
        if len(out[country]) >= 8:
            continue

        out[country].append(
            {
                "city": c["city"],
                "score": float(score),
                "reason": f"Matches your travel profile (score {float(score):.2f}).",
            }
        )

    return jsonify({"ok": True, "suggestions": out})


# ------------------------------------------------------------------------------
# DB init
# ------------------------------------------------------------------------------
with app.app_context():
    db.create_all()
    _ensure_state_row()


# ------------------------------------------------------------------------------
# Run
# ------------------------------------------------------------------------------
if __name__ == "__main__":
    # In PyCharm, you can also run via the Run configuration
    app.run(host="127.0.0.1", port=5000, debug=True)
