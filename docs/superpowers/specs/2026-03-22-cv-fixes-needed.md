# CV Fixes Needed

Issues discovered during envelope rendering work (2026-03-22).

## Room Detection Issues

1. **Most rooms labeled "Room N"** — CV detected 13 rooms but only 1 ("Bedroom") had a correct label. All others were generic "Room 1", "Room 2", etc. The OCR/text-matching pipeline is not associating labels with detected room polygons.

2. **Noisy polygon geometry** — Several rooms had wildly incorrect polygon shapes (e.g., "Room" with 12 vertices forming an irregular shape that spans multiple actual rooms). The polygon merge/simplification step is producing unusable geometry.

3. **Wall thickness underestimated** — CV reported interior=5cm, exterior=10cm. Actual walls in this floor plan appear to be interior=10cm, exterior=20cm (standard residential). The wall thickness detection needs calibration.

4. **Low-confidence rooms included** — Rooms with confidence=0.3 and 0.5 were included in the output. These were mostly noise (e.g., "Room 13" at confidence 0.3 detected by only 1 strategy). Need a higher confidence threshold or better filtering.

5. **Missing room type classification** — All rooms returned as "other" type except "Bedroom". Even obvious rooms like Kitchen, Bathroom, Living Room, Closet, Balcony were not typed despite OCR detecting their labels.

## Scale / Dimension Issues

6. **Scale factor seems off** — CV reported 0.62 cm/px but the resulting coordinates don't align well with the labeled dimensions in the image (e.g., Living/Dining is labeled 11'3" x 21'8" = 343x660cm but CV geometry suggests much smaller).

## Recommendations

- **Short-term**: The generate_floor_plan workflow should continue to require manual room layout construction from the image, using CV output only as a rough guide.
- **Medium-term**: Fix label-to-room association, increase confidence threshold, add room type inference from detected text labels.
- **Long-term**: Improve polygon simplification to produce clean axis-aligned rectangles for rectangular rooms.
