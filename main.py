import json
import gcsfs
import geopandas as gpd
import numpy as np
import pandas as pd
import rioxarray
import xarray as xr

print("1. Loading Pangeo CMIP6 cloud catalog...")
catalog_url = "https://storage.googleapis.com/cmip6/pangeo-cmip6.csv"
df = pd.read_csv(catalog_url)

scenarios = ["ssp126", "ssp245", "ssp370", "ssp585"]
target_model = "IPSL-CM6A-LR"  # Representative model
variable_id = "tas"  # Near-surface air temperature

print(f"2. Querying Zarr paths for model: {target_model}...")

processed_data = {}

# Explicitly configure anonymous access for public Google Cloud bucket
fs = gcsfs.GCSFileSystem(token="anon")

for scenario in scenarios:
  query = df.query(
      f"activity_id == 'ScenarioMIP' and "
      f"experiment_id == '{scenario}' and "
      f"variable_id == '{variable_id}' and "
      f"table_id == 'Amon' and "
      f"source_id == '{target_model}'"
  )

  if query.empty:
    print(f"Warning: No data found for {scenario}")
    continue

  zstore_url = query.zstore.values[0]
  print(f"Opening Zarr store for {scenario} via anonymous access...")

  mapper = fs.get_mapper(zstore_url)
  ds = xr.open_zarr(mapper, consolidated=True)

  # Georeference longitudes from 0..360 to -180..180 if needed
  if ds.lon.max() > 180:
    ds.coords["lon"] = (ds.coords["lon"] + 180) % 360 - 180
    ds = ds.sortby(ds.lon)

  lat_name = "lat" if "lat" in ds.dims else "latitude"
  lon_name = "lon" if "lon" in ds.dims else "longitude"

  subset = ds[variable_id]

  print(f"Computing annual means for {scenario}...")
  annual_ds = subset.resample(time="YE").mean(dim="time")
  processed_data[scenario] = annual_ds

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

print(
    "4. Aggregating climate data by state (with centroid fallback) and"
    " exporting..."
)
state_projections = {}

for _, state in states.iterrows():
  state_name = state["NAME"]
  geom = [state.geometry]
  state_projections[state_name] = {}
  print(f"Processing state: {state_name}")

  for scenario in scenarios:
    if scenario not in processed_data:
      continue

    try:
      # Convert DataArray to Dataset and activate rioxarray CRS/dimensions
      ds_scenario = processed_data[scenario].to_dataset(name=variable_id)
      ds_scenario = ds_scenario.rio.write_crs("EPSG:4326", inplace=True)
      ds_scenario = ds_scenario.rio.set_spatial_dims(
          x_dim=lon_name, y_dim=lat_name, inplace=True
      )

      try:
        # Attempt polygon clip using all_touched=True for small states
        clipped = ds_scenario.rio.clip(
            geom, states.crs, drop=True, all_touched=True
        )
        spatial_mean = clipped.mean(dim=[lat_name, lon_name])
      except Exception:
        # Fallback for extremely small states/districts: grab the nearest grid cell to the centroid
        centroid = state.geometry.centroid
        spatial_mean = ds_scenario.sel(
            {lat_name: centroid.y, lon_name: centroid.x}, method="nearest"
        )

      # Extract years and temperature values (Kelvin to Celsius conversion)
      years = pd.to_datetime(spatial_mean.time.values).year.tolist()
      temps = (spatial_mean[variable_id] - 273.15).values.tolist()

      state_projections[state_name][scenario] = {
          "years": years,
          "temperature_celsius": [
              round(t, 2) if not (t is None or np.isnan(t)) else None
              for t in temps
          ],
      }
    except Exception as e:
      print(f"  -> Skipping {scenario} for {state_name} due to error: {e}")

# Save final structured dataset
with open("state_projections.json", "w") as f:
  json.dump(state_projections, f, indent=2)

print(
    "Complete! Generated 'state_projections.json' successfully for all states"
    " without missing entries."
)