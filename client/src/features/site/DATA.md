# Askervein terrain data

`askervein.ts` contains a 33 × 33 grid of unsigned decimetre elevations sampled over a
2 km square centred at 57°11′16.63″N, 7°22′45.07″W. The source is the Copernicus DEM
GLO-30 2021 AWS Open Data tile `Copernicus_DSM_COG_10_N57_00_W008_00_DEM`.

Attribution: produced using Copernicus WorldDEM-30 © DLR e.V. 2010–2014 and © Airbus
Defence and Space GmbH 2014–2018, provided under COPERNICUS by the European Union and
ESA; all rights reserved.

The packed little-endian values are decoded once in the browser and divided by ten. The
same array is used for the rendered terrain and the `/api/field` request so visual and
computed relief cannot drift apart.

