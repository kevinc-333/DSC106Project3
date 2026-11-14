"""Build state_projections.json from CMIP6 (IPSL-CM6A-LR) on Google Cloud.

For every U.S. state (+ DC) this script produces:
  * a historical baseline (1995-2014 mean) for temperature and precipitation
  * annual-mean projections for 2015-2100 under SSP1-2.6, SSP2-4.5,
    SSP3-7.0 and SSP5-8.5

Variables (CMIP6 table Amon, i.e. monthly atmosphere):
  tas  near-surface air temperature  K            -> degrees C
  pr   precipitation flux            kg m-2 s-1   -> mm/day  (x 86400)

Requirements: pip install gcsfs geopandas rioxarray xarray zarr cftime pandas numpy
"""

import json
import os

import gcsfs
import geopandas as gpd
import numpy as np
import pandas as pd
import rioxarray  # noqa: F401  (registers the .rio accessor)
import xarray as xr

SCENARIOS = ["ssp126", "ssp245", "ssp370", "ssp585"]
TARGET_MODEL = "IPSL-CM6A-LR"  # Representative model
MEMBER_ID = "r1i1p1f1"  # Same ensemble member for every run
VARIABLES = ["tas", "pr"]
BASELINE_YEARS = (1995, 2014)  # IPCC AR6 "recent past" reference period

# Rough bounding box around the 50 states, used to cut the global grid down
# before loading it into memory.
US_LAT = (15, 75)
US_LON = (-180, -60)

print("1. Loading Pangeo CMIP6 cloud catalog...")
# data.csv in this repo is a local copy of the Pangeo catalog; fall back to
# the online version if it isn't there.
catalog_path = "data.csv"
if not os.path.exists(catalog_path):
  catalog_path = "https://storage.googleapis.com/cmip6/pangeo-cmip6.csv"
catalog = pd.read_csv(catalog_path)

# Explicitly configure anonymous access for public Google Cloud bucket
fs = gcsfs.GCSFileSystem(token="anon")


def open_annual(experiment_id, variable_id):
  """Open one CMIP6 Zarr store and return annual means over the U.S. box."""
  activity = "CMIP" if experiment_id == "historical" else "ScenarioMIP"
  query = catalog.query(
      f"activity_id == '{activity}' and "
      f"experiment_id == '{experiment_id}' and "
      f"variable_id == '{variable_id}' and "
      "table_id == 'Amon' and "
      f"source_id == '{TARGET_MODEL}' and "
      f"member_id == '{MEMBER_ID}'"
  )
  if query.empty:
    print(f"  Warning: no {variable_id} data found for {experiment_id}")
    return None

  zstore_url = query.zstore.values[0]
  print(f"  Opening {variable_id} / {experiment_id}: {zstore_url}")
  ds = xr.open_zarr(fs.get_mapper(zstore_url), consolidated=True)

  # Georeference longitudes from 0..360 to -180..180 if needed
  if ds.lon.max() > 180:
    ds.coords["lon"] = (ds.coords["lon"] + 180) % 360 - 180
    ds = ds.sortby(ds.lon)
  ds = ds.sortby(ds.lat)

  da = ds[variable_id].sel(lat=slice(*US_LAT), lon=slice(*US_LON))

  if experiment_id == "historical":
    da = da.sel(time=slice(str(BASELINE_YEARS[0]), str(BASELINE_YEARS[1])))

  # Unit conversion
  if variable_id == "tas":
    da = da - 273.15  # K -> degrees C
  elif variable_id == "pr":
    da = da * 86400.0  # kg m-2 s-1 -> mm/day

  # Calendar-agnostic annual mean (works for cftime and datetime64)
  return da.groupby("time.year").mean("time").load()


print(f"2. Downloading {VARIABLES} for {TARGET_MODEL} ({MEMBER_ID})...")
datasets = {}  # experiment -> xr.Dataset with tas + pr, dims (year, lat, lon)
for experiment in ["historical"] + SCENARIOS:
  arrays = {}
  for var in VARIABLES:
    annual = open_annual(experiment, var)
    if annual is not None:
      arrays[var] = annual
  if arrays:
    ds = xr.Dataset(arrays)
    ds = ds.rio.write_crs("EPSG:4326")
    ds = ds.rio.set_spatial_dims(x_dim="lon", y_dim="lat")
    datasets[experiment] = ds

print("3. Loading U.S. State boundaries for spatial aggregation...")
states = gpd.read_file(
    "https://www2.census.gov/geo/tiger/GENZ2018/shp/cb_2018_us_state_500k.zip"
)

# Filter out international territories, keeping all 50 states + DC
states = states[
    ~states["NAME"].isin(
        [
            "Puerto Rico",
            "United States Virgin Islands",
            "American Samoa",
            "Guam",
            "Commonwealth of the Northern Mariana Islands",
        ]
    )
]


def state_mean(ds, state):
  """Average a gridded dataset over one state's polygon."""
  try:
    # all_touched=True so that small states still pick up grid cells
    clipped = ds.rio.clip(
        [state.geometry], states.crs, drop=True, all_touched=True
    )
    return clipped.mean(dim=["lat", "lon"])
  except Exception:
    # Fallback for extremely small states/districts: nearest grid cell
    centroid = state.geometry.centroid
    return ds.sel(lat=centroid.y, lon=centroid.x, method="nearest")


def clean(values, digits):
  return [
      None if (v is None or np.isnan(v)) else round(float(v), digits)
      for v in values
  ]


print("4. Aggregating climate data by state and exporting...")
state_projections = {}

for _, state in states.iterrows():
  state_name = state["NAME"]
  print(f"  Processing state: {state_name}")
  entry = {}

  if "historical" in datasets:
    hist = state_mean(datasets["historical"], state).mean("year")
    entry["baseline"] = {
        "years": list(BASELINE_YEARS),
        "temperature_celsius": round(float(hist["tas"]), 2),
        "precipitation_mm_per_day": round(float(hist["pr"]), 3),
    }

  for scenario in SCENARIOS:
    if scenario not in datasets:
      continue
    try:
      series = state_mean(datasets[scenario], state)
      series = series.sel(year=slice(2015, 2100))
      entry[scenario] = {
          "years": [int(y) for y in series.year.values],
          "temperature_celsius": clean(series["tas"].values, 2),
          "precipitation_mm_per_day": clean(series["pr"].values, 3),
      }
    except Exception as e:
      print(f"    -> Skipping {scenario} for {state_name} due to error: {e}")

  state_projections[state_name] = entry

# Save final structured dataset (compact, it is loaded by the browser)
with open("state_projections.json", "w") as f:
  json.dump(state_projections, f, separators=(",", ":"))

print(
    f"Complete! Wrote state_projections.json for {len(state_projections)}"
    " states."
)
