import * as Cesium from "cesium";

// =============================================================================
// Types
// =============================================================================

export interface RadarOptions {
    entityId: string;
    longitude: number;
    latitude: number;
    altitude?: number;
    beam: BeamSettings;
    azimuthStepDeg?: number;
    style: RadarStyle;
}

// The one beam the radar sends out: a single sheet at one elevation angle,
// spread over the beam width (360 = every direction round the radar).
export interface BeamSettings {
    // Centre of the beam, degrees clockwise from north.
    azimuthDeg: number;
    // Horizontal width of the beam (360 = all round).
    widthDeg: number;
    range: number;
    // Elevation angle of the beam (0 = level with the antenna).
    elevationDeg: number;
    // Height above the terrain of the aircraft the LOS probe works out for.
    targetHeightAgl: number;
    // Antenna height above the ground it stands on.
    mastHeight: number;
    // Rays drawn across the beam.
    raysAcross: number;
}

// Settings that only change how the coverage looks. Applied in place through
// RadarCoverageHandle.setStyle, without re-sampling terrain or rebuilding.
export interface RadarStyle {
    beamOpacity: number;
    showBeam: boolean;
    // Ground behind the terrain that stops the beam.
    blockedOpacity: number;
    showBlocked: boolean;
    showRays: boolean;
    showLabels: boolean;
    // Also show every lower angle from 0° up to the beam (a solid fan), not
    // just the sheet at the beam's own angle.
    showLowerBeams: boolean;
    // Ground footprint: green where the radar sees the ground, dark where
    // terrain hides it (the same at every beam angle).
    showFootprint: boolean;
    footprintOpacity: number;
}

// One stretch of directions in which terrain stops the beam.
export interface BlockedSector {
    fromDeg: number;
    toDeg: number;
    widthDeg: number;
    // Closest point where the beam meets the terrain in this sector.
    nearestHitM: number;
    // Lowest beam angle that clears the terrain across the whole sector.
    clearDeg: number;
    // Every direction of the beam is blocked (no clear gap anywhere).
    allRound: boolean;
}

// What the beam at its current angle reaches, for the panel.
export interface BeamScanResult {
    elevationDeg: number;
    startDeg: number;
    widthDeg: number;
    range: number;
    // Share of directions where the beam runs the full range (0-100).
    clearPct: number;
    // Lowest beam angle at which every direction in the beam width is clear.
    allClearDeg: number;
    sectors: BlockedSector[];
    // Lowest clear angle per direction, binned across the beam width.
    horizon: { azDeg: number; clearDeg: number }[];
}

export interface RadarCoverageHandle {
    dispose(): void;
    setStyle?(style: RadarStyle): void;
    scan?: BeamScanResult;
}

export interface ResolvedZone {
    name: string;
    color: Cesium.Color;
    range: number;
    minElevationDeg: number;
    maxElevationDeg: number;
    azimuthStartDeg: number;
    azimuthWidthDeg: number;
}

export interface RadarZoneConfig {
    name: string;
    cssColor: string;
    color: Cesium.Color;
}

// What a built radar needs to answer "can it see this point, and if not, why?".
// Kept per radar entity for the click-to-explain probe (see CesiumLosProbe).
export interface RadarGeometry {
    radarPosition: Cesium.Cartesian3;
    radarHeight: number;
    enuMatrix: Cesium.Matrix4;
    zones: ResolvedZone[];
    targetHeightAgl: number;
}

interface TerrainProfile {
    azimuthDeg: number;
    horizontalDistances: number[];
    groundHeights: number[];
    groundPoints: Cesium.Cartographic[];
}

// Terrain seen from the antenna along one direction.
interface RayTrace {
    // Elevation angle (radians) from the antenna to the ground at each sample,
    // and the highest such angle up to and including that sample (-Infinity
    // next to the antenna, which never blocks). A ray at angle a meets the
    // terrain at the first sample where peakAngle >= a.
    groundAngle: Float32Array;
    peakAngle: Float32Array;
}

// Every direction of the beam: row = direction, column = range sample.
interface RayGrid {
    zone: ResolvedZone;
    wrap: boolean;
    profiles: TerrainProfile[];
    rays: RayTrace[];
    // Azimuth of each row (degrees, unwrapped) and the spacing between rows.
    rowAz: number[];
    rowStepDeg: number;
    enuMatrix: Cesium.Matrix4;
}

// Where the beam ends in each direction.
interface BeamTips {
    dist: Float64Array;
    hit: Uint8Array;
    // Lowest clear angle (degrees) per direction.
    clearDeg: Float64Array;
}

// =============================================================================
// Defaults & tuning
// =============================================================================

export const DEFAULT_TARGET_HEIGHT_AGL_M = 0;
// A radar with no mast set stands on a 10 m mast. With the antenna right on
// the terrain, every 2-3 m bump in the terrain data next to it tilts the
// horizon up by degrees and throws long false shadows.
export const DEFAULT_MAST_HEIGHT_M = 10;

export const DEFAULT_BEAM: Omit<BeamSettings, "targetHeightAgl" | "mastHeight" | "raysAcross"> = {
    azimuthDeg: 0,
    widthDeg: 360,
    range: 20000,
    elevationDeg: 0
};

export const DEFAULT_RADAR_STYLE: RadarStyle = {
    beamOpacity: 0.25,
    showBeam: true,
    blockedOpacity: 0.5,
    showBlocked: true,
    showRays: false,
    showLabels: true,
    showLowerBeams: false,
    showFootprint: false,
    footprintOpacity: 0.45
};

const CLEAR_RGB = [34, 197, 94];       // #22c55e  beam runs the full range
const BLOCKED_RGB = [239, 68, 68];     // #ef4444  beam stopped by terrain
const SEEN_RGB = [34, 197, 94];        // #22c55e  footprint: ground the radar sees
const HIDDEN_RGB = [31, 41, 55];       // #1f2937  footprint: ground hidden by terrain
const CLEAR_COLOR = Cesium.Color.fromBytes(CLEAR_RGB[0], CLEAR_RGB[1], CLEAR_RGB[2]);
const BLOCKED_COLOR = Cesium.Color.fromBytes(BLOCKED_RGB[0], BLOCKED_RGB[1], BLOCKED_RGB[2]);
const HIT_LINE_COLOR = Cesium.Color.fromCssColorString("#7f1d1d");
// Green ground under the beam is drawn this much fainter than the red, so
// the blocked areas stand out.
const REACH_ALPHA = 0.55;
const RAY_HIT_COLOR = Cesium.Color.fromCssColorString("#f59e0b");   // ray stopped by terrain
const RAY_CLEAR_COLOR = Cesium.Color.fromCssColorString("#bbf7d0"); // ray reaches full range

// World terrain is ~30 m detail in most mountain areas; sampling finer than
// this costs time without adding real accuracy.
const TERRAIN_SAMPLE_SPACING_M = 10;
// Directions across the beam when no azimuth step is set: about this many, but
// never closer than MIN_AZIMUTH_STEP_DEG or further apart than MAX_AZIMUTH_STEP_DEG.
const TARGET_RAYS_ACROSS_BEAM = 240;
const MIN_AZIMUTH_STEP_DEG = 0.1;
const MAX_AZIMUTH_STEP_DEG = 1;
// Terrain profiles kept from earlier builds (most recent last).
const PROFILE_CACHE_SIZE = 8;
const EARTH_RADIUS_M = 6371000;
// Standard radar "4/3 Earth" model: the atmosphere bends the beam slightly
// downward, so it reaches as if the Earth were 4/3 larger (flatter).
const EFFECTIVE_EARTH_RADIUS_M = EARTH_RADIUS_M * 4 / 3;
// Ground closer than this to the antenna never blocks it (the antenna's own
// footing / cleared site; the terrain data is too coarse to trust here).
const NEAR_FIELD_IGNORE_M = 50;
// Terrain only blocks a point if it rises more than this above the straight
// line from the antenna to that point (smaller rises are terrain-data noise).
const RIDGE_TOLERANCE_M = 2;
// Beam sheet: at most this many directions, and points along each.
const BEAM_MESH_MAX_ROWS = 360;
const BEAM_RAY_POINTS = 40;
// The beam sheet fades in from the antenna: alpha at the antenna, relative
// to the far end (radar-display look, and the ground near the radar stays
// readable).
const BEAM_NEAR_ALPHA = 0.25;
// Faint range rings on the beam, as fractions of the range.
const RANGE_RING_FRACTIONS = [0.25, 0.5, 0.75];
const RANGE_RING_COLOR = Cesium.Color.WHITE.withAlpha(0.35);
// Lower beams: the angle they start from, one level every this many degrees
// (at most LOWER_MAX_LEVELS), and their opacity relative to the beam's.
const LOWER_BEAMS_FLOOR_DEG = 0;
const LOWER_LEVEL_STEP_DEG = 0.25;
const LOWER_MAX_LEVELS = 120;
const LOWER_FLOOR_ALPHA = 0.5;
const LOWER_WALL_ALPHA = 1.2;
// Blocked sectors separated by a clear gap narrower than this are one sector
// in the panel list and map labels (the map shading keeps every gap).
const SECTOR_MERGE_GAP_DEG = 1;
// Map labels: the widest sectors only, and none narrower than MIN_LABEL_WIDTH_DEG
// (those are still in the panel list).
const MAX_SECTOR_LABELS = 6;
const MIN_LABEL_WIDTH_DEG = 3;
const LABEL_MIN_RANGE_FRACTION = 0.45;
// Bins of the horizon profile handed to the panel chart.
const HORIZON_BINS = 180;
// Footprint texture: largest side in pixels, and footprints kept from
// earlier builds (it does not change with the beam angle, so the angle
// slider and the scan reuse it).
const FOOTPRINT_TEXTURE_MAX_PX = 1024;
const FOOTPRINT_CACHE_SIZE = 4;
// Footprint visibility score is clamped to +-this (metres), so edges blend.
const FOOTPRINT_SCORE_CLAMP_M = 25;
// Range arc of the shading: one point every this many degrees.
const ARC_STEP_DEG = 1;
const MAX_RAYS_ACROSS = 180;
const RAY_LINE_POINTS = 16;
// Drawn rays across the beam when not set: one every this many degrees.
const DEFAULT_RAY_SPACING_DEG = 5;
const HIT_POINT_ALWAYS_VISIBLE_M = 3000;

// =============================================================================
// CesiumRadarCoverage: one beam at one angle, cut by terrain
// =============================================================================

export class CesiumRadarCoverage {
    // The radar's single beam, as a "zone" for the LOS probe.
    public static readonly DEFAULT_3D_ZONES: RadarZoneConfig[] = [
        { name: "Beam", cssColor: "#22c55e", color: CLEAR_COLOR }
    ];

    // Geometry of every built radar, keyed by entity id.
    private static readonly geometries = new Map<string, RadarGeometry>();

    static getGeometry(entityId: string): RadarGeometry | undefined {
        return CesiumRadarCoverage.geometries.get(entityId);
    }

    static radarIds(): string[] {
        return Array.from(CesiumRadarCoverage.geometries.keys());
    }

    // Beam settings stored on a radar entity's properties. Older radars kept
    // the range per zone; that is used when no beam range is set.
    static beamOf(props: Record<string, any>): BeamSettings {
        const widthDeg = props["beamWidthDeg"] ?? DEFAULT_BEAM.widthDeg;
        return {
            azimuthDeg: props["beamAzimuthDeg"] ?? DEFAULT_BEAM.azimuthDeg,
            widthDeg,
            range: props["beamRange"] ?? props["zoneRanges"]?.["Coverage Zone"] ?? DEFAULT_BEAM.range,
            elevationDeg: props["beamElevationDeg"] ?? DEFAULT_BEAM.elevationDeg,
            targetHeightAgl: props["targetHeightAgl"] ?? DEFAULT_TARGET_HEIGHT_AGL_M,
            mastHeight: props["antennaMastHeight"] ?? DEFAULT_MAST_HEIGHT_M,
            raysAcross: props["raysAcross"] ?? Cesium.Math.clamp(
                Math.round(widthDeg / DEFAULT_RAY_SPACING_DEG) + (widthDeg >= 360 ? 0 : 1), 3, MAX_RAYS_ACROSS)
        };
    }

    static styleOf(props: Record<string, any>): RadarStyle {
        return {
            beamOpacity: props["beamOpacity"] ?? DEFAULT_RADAR_STYLE.beamOpacity,
            showBeam: props["showBeam"] ?? DEFAULT_RADAR_STYLE.showBeam,
            blockedOpacity: props["blockedOpacity"] ?? DEFAULT_RADAR_STYLE.blockedOpacity,
            showBlocked: props["showBlocked"] ?? DEFAULT_RADAR_STYLE.showBlocked,
            showRays: props["showRays"] ?? DEFAULT_RADAR_STYLE.showRays,
            showLabels: props["showLabels"] ?? DEFAULT_RADAR_STYLE.showLabels,
            showLowerBeams: props["showLowerBeams"] ?? DEFAULT_RADAR_STYLE.showLowerBeams,
            showFootprint: props["showFootprint"] ?? DEFAULT_RADAR_STYLE.showFootprint,
            footprintOpacity: props["footprintOpacity"] ?? DEFAULT_RADAR_STYLE.footprintOpacity
        };
    }

    // -------------------------------------------------------------------
    // 1. Main entry point
    // -------------------------------------------------------------------
    static async create3DRadarZones(
        viewer: Cesium.Viewer,
        terrainProvider: Cesium.TerrainProvider,
        options: RadarOptions
    ): Promise<RadarCoverageHandle[]> {
        // Anything already drawn is removed again if the build fails part way,
        // so a failed build never leaves pieces of itself on the map.
        const handles: RadarCoverageHandle[] = [];
        try {
            await CesiumRadarCoverage.buildInto(viewer, terrainProvider, options, handles);
            return handles;
        } catch (err) {
            for (const handle of handles) handle.dispose();
            throw err;
        }
    }

    private static async buildInto(
        viewer: Cesium.Viewer,
        terrainProvider: Cesium.TerrainProvider,
        options: RadarOptions,
        handles: RadarCoverageHandle[]
    ): Promise<void> {

        const { entityId, longitude, latitude } = options;
        const mastHeight = Math.max(0, options.beam.mastHeight);

        // Ground polylines are built synchronously, so the old coverage is only
        // swapped out once the new one is ready to draw (no flicker while scanning).
        await Cesium.GroundPolylinePrimitive.initializeTerrainHeights();

        const cartographic = Cesium.Cartographic.fromDegrees(longitude, latitude);
        const [sampled] = await Cesium.sampleTerrainMostDetailed(terrainProvider, [cartographic]);
        const terrainHeight = sampled.height ?? 0;
        const radarHeight = terrainHeight + mastHeight;
        const radarPosition = Cesium.Cartesian3.fromDegrees(longitude, latitude, radarHeight);
        const enuMatrix = Cesium.Transforms.eastNorthUpToFixedFrame(radarPosition);

        // Emitter marker
        const marker = viewer.entities.add({
            position: radarPosition,
            point: {
                pixelSize: 16,
                color: Cesium.Color.BLACK,
                outlineColor: Cesium.Color.WHITE,
                outlineWidth: 3,
                disableDepthTestDistance: Number.POSITIVE_INFINITY
            }
        });
        (marker as any).radarParentId = entityId;
        // Clicking the radar itself always selects it, even with the LOS probe on.
        (marker as any).isRadarMarker = true;
        handles.push({ dispose: () => viewer.entities.remove(marker) });

        // The beam
        const elevationDeg = options.beam.elevationDeg;
        const widthDeg = Cesium.Math.clamp(options.beam.widthDeg, 1, 360);
        const wrap = widthDeg >= 360;
        const zone: ResolvedZone = {
            name: "Beam",
            color: CLEAR_COLOR,
            range: Math.max(100, options.beam.range),
            minElevationDeg: elevationDeg,
            maxElevationDeg: elevationDeg,
            azimuthStartDeg: wrap ? 0 : options.beam.azimuthDeg - widthDeg / 2,
            azimuthWidthDeg: widthDeg
        };
        const targetHeightAgl = Math.max(0, options.beam.targetHeightAgl);

        const geometry: RadarGeometry = { radarPosition, radarHeight, enuMatrix, zones: [zone], targetHeightAgl };
        CesiumRadarCoverage.geometries.set(entityId, geometry);
        handles.push({
            dispose: () => {
                // A newer build of the same radar may already have replaced it.
                if (CesiumRadarCoverage.geometries.get(entityId) === geometry) {
                    CesiumRadarCoverage.geometries.delete(entityId);
                }
            }
        });

        // Terrain along every direction of the beam (cached: changing only the
        // angle reuses it, which is what keeps the angle slider and scan live).
        const azimuthStepDeg = options.azimuthStepDeg ?? Cesium.Math.clamp(
            widthDeg / TARGET_RAYS_ACROSS_BEAM, MIN_AZIMUTH_STEP_DEG, MAX_AZIMUTH_STEP_DEG
        );
        const azimuthsDeg = CesiumRadarCoverage.buildAzimuthList(zone.azimuthStartDeg, widthDeg, azimuthStepDeg);
        const profiles = await CesiumRadarCoverage.getTerrainProfiles(
            terrainProvider,
            `${longitude}|${latitude}|${zone.azimuthStartDeg}|${widthDeg}|${azimuthStepDeg}`,
            radarPosition,
            enuMatrix,
            azimuthsDeg,
            zone.range,
            TERRAIN_SAMPLE_SPACING_M
        );

        const rows = profiles.length;
        const rowStepDeg = wrap ? 360 / rows : widthDeg / Math.max(1, rows - 1);
        const grid: RayGrid = {
            zone,
            wrap,
            profiles,
            rays: profiles.map(p => CesiumRadarCoverage.traceRay(p, radarHeight)),
            rowAz: profiles.map((_, r) => zone.azimuthStartDeg + rowStepDeg * r),
            rowStepDeg,
            enuMatrix
        };

        // Where the beam ends in every direction.
        const angle = Cesium.Math.toRadians(elevationDeg);
        const lastCol = CesiumRadarCoverage.lastColumn(grid);
        const tips: BeamTips = {
            dist: new Float64Array(rows),
            hit: new Uint8Array(rows),
            clearDeg: new Float64Array(rows)
        };
        for (let r = 0; r < rows; r++) {
            const tip = CesiumRadarCoverage.rayTip(grid, r, angle, lastCol);
            tips.dist[r] = tip.dist;
            tips.hit[r] = tip.hit ? 1 : 0;
            const peak = grid.rays[r].peakAngle[lastCol];
            tips.clearDeg[r] = Number.isFinite(peak) ? Cesium.Math.toDegrees(peak) : -90;
        }
        const runs = CesiumRadarCoverage.blockedRuns(tips.hit, wrap);
        const scan = CesiumRadarCoverage.summarise(grid, tips, runs, elevationDeg);

        const beam = CesiumRadarCoverage.buildBeam(viewer, entityId, grid, tips, radarHeight, angle, lastCol);
        const lower = CesiumRadarCoverage.buildLowerBeams(
            viewer, entityId, grid, radarHeight, Math.min(LOWER_BEAMS_FLOOR_DEG, elevationDeg), elevationDeg, lastCol);
        const blocked = CesiumRadarCoverage.buildBlockedArea(viewer, entityId, grid, tips, runs, lastCol);
        const footprint = CesiumRadarCoverage.buildFootprint(
            viewer, entityId, grid, longitude, latitude,
            `${longitude}|${latitude}|${radarHeight}|${zone.azimuthStartDeg}|${widthDeg}|${zone.range}|${rows}`);
        const labels = CesiumRadarCoverage.buildSectorLabels(viewer, entityId, grid, tips, scan.sectors, lastCol);
        const rayFan = CesiumRadarCoverage.buildRays(
            viewer, grid, radarHeight, angle,
            Math.round(Cesium.Math.clamp(options.beam.raysAcross, 1, MAX_RAYS_ACROSS))
        );
        handles.push(beam, lower, blocked, footprint, labels, rayFan);

        const applyStyle = (st: RadarStyle) => {
            beam.setStyle(st);
            lower.setStyle(st);
            blocked.setStyle(st);
            footprint.setStyle(st);
            labels.setStyle(st);
            rayFan.setStyle(st);
            viewer.scene.requestRender();
        };
        applyStyle(options.style);
        handles.push({ dispose: () => { }, setStyle: applyStyle, scan });

        viewer.scene.requestRender();
    }

    // -------------------------------------------------------------------
    // 2. Terrain seen along one direction: traceRay
    // -------------------------------------------------------------------
    // peakAngle is the steepest line from the antenna that still touches
    // terrain so far (less the small-rise tolerance), so a ray at angle a runs
    // the full range exactly when a > peakAngle at the last sample.
    private static traceRay(profile: TerrainProfile, radarHeight: number): RayTrace {
        const { horizontalDistances: dists, groundHeights } = profile;
        const n = dists.length;
        const groundAngle = new Float32Array(n).fill(-Math.PI / 2);
        const peakAngle = new Float32Array(n).fill(-Infinity);
        for (let i = 1; i < n; i++) {
            const d = dists[i];
            groundAngle[i] = CesiumRadarCoverage.elevationAngle(groundHeights[i], d, radarHeight);
            peakAngle[i] = d < NEAR_FIELD_IGNORE_M
                ? peakAngle[i - 1]
                : Math.max(peakAngle[i - 1], Math.atan(CesiumRadarCoverage.horizonTan(groundAngle[i], d)));
        }
        return { groundAngle, peakAngle };
    }

    // Last range sample that is within the beam's range.
    private static lastColumn(grid: RayGrid): number {
        const dists = grid.profiles[0].horizontalDistances;
        let c = dists.length - 1;
        while (c > 0 && dists[c] > grid.zone.range) c--;
        return c;
    }

    // Where a ray at `angle` (radians) along grid row r first meets the
    // terrain: the first sample whose ground is at or above the ray, found by
    // binary search on the running highest ground angle, then the exact
    // crossing between that sample and the one before. hit = false: the ray
    // stays above the terrain out to the full range.
    private static rayTip(grid: RayGrid, r: number, angle: number, lastCol: number): { dist: number; hit: boolean } {
        const { peakAngle, groundAngle } = grid.rays[r];
        const dists = grid.profiles[r].horizontalDistances;
        if (!(peakAngle[lastCol] >= angle)) return { dist: dists[lastCol], hit: false };
        let lo = 1, hi = lastCol;
        while (lo < hi) {
            const mid = (lo + hi) >> 1;
            if (peakAngle[mid] >= angle) hi = mid;
            else lo = mid + 1;
        }
        const a0 = groundAngle[lo - 1], a1 = groundAngle[lo];
        const t = a1 > a0 ? Cesium.Math.clamp((angle - a0) / (a1 - a0), 0, 1) : 0;
        return { dist: dists[lo - 1] + (dists[lo] - dists[lo - 1]) * t, hit: true };
    }

    // Ground point (lon, lat in radians, terrain height) at a distance along grid row r.
    private static groundAt(grid: RayGrid, r: number, d: number, lastCol: number) {
        const { horizontalDistances: dists, groundHeights: heights, groundPoints: pts } = grid.profiles[r];
        const spacing = dists.length > 1 ? dists[1] - dists[0] : TERRAIN_SAMPLE_SPACING_M;
        const f = Math.min(Math.max(0, d) / spacing, lastCol);
        const i0 = Math.floor(f), i1 = Math.min(i0 + 1, lastCol), u = f - i0;
        return {
            lon: pts[i0].longitude + (pts[i1].longitude - pts[i0].longitude) * u,
            lat: pts[i0].latitude + (pts[i1].latitude - pts[i0].latitude) * u,
            height: heights[i0] + (heights[i1] - heights[i0]) * u
        };
    }

    // Ground-level point at this azimuth and horizontal distance (for draped shapes).
    private static planePoint(grid: RayGrid, azDeg: number, d: number): Cesium.Cartesian3 {
        const az = Cesium.Math.toRadians(azDeg);
        return Cesium.Matrix4.multiplyByPoint(
            grid.enuMatrix, new Cesium.Cartesian3(Math.sin(az) * d, Math.cos(az) * d, 0), new Cesium.Cartesian3());
    }

    // -------------------------------------------------------------------
    // 3. Blocked stretches of directions
    // -------------------------------------------------------------------
    // Contiguous rows whose ray meets the terrain, as [first, last] row. On an
    // all-round beam a run may wrap past the last row (last < first), and a
    // beam blocked all round is one run [0, rows - 1].
    private static blockedRuns(hit: Uint8Array, wrap: boolean): [number, number][] {
        const rows = hit.length;
        const runs: [number, number][] = [];
        let r = 0;
        while (r < rows) {
            if (!hit[r]) { r++; continue; }
            const from = r;
            while (r < rows && hit[r]) r++;
            runs.push([from, r - 1]);
        }
        if (wrap && runs.length > 1 && runs[0][0] === 0 && runs[runs.length - 1][1] === rows - 1) {
            const last = runs.pop()!;
            runs[0] = [last[0], runs[0][1]];
        }
        return runs;
    }

    private static runRows(run: [number, number], rows: number): number[] {
        const [from, to] = run;
        const count = to >= from ? to - from + 1 : rows - from + to + 1;
        return Array.from({ length: count }, (_, k) => (from + k) % rows);
    }

    // Panel summary: blocked sectors (small clear gaps merged), how much of
    // the beam is clear, and the lowest angle that clears every direction.
    private static summarise(grid: RayGrid, tips: BeamTips, runs: [number, number][], elevationDeg: number): BeamScanResult {
        const rows = tips.hit.length;
        const { zone, rowAz, rowStepDeg } = grid;
        const norm = (a: number) => ((a % 360) + 360) % 360;

        // Merge runs separated by a narrow clear gap.
        const maxGapRows = Math.max(0, Math.floor(SECTOR_MERGE_GAP_DEG / rowStepDeg));
        const merged: [number, number][] = [];
        for (const run of runs) {
            const prev = merged[merged.length - 1];
            if (prev && run[0] - prev[1] - 1 <= maxGapRows && run[0] > prev[1]) prev[1] = run[1];
            else merged.push([run[0], run[1]]);
        }
        if (grid.wrap && merged.length > 1) {
            const first = merged[0], last = merged[merged.length - 1];
            const gap = (first[0] - last[1] - 1 + rows) % rows;
            if (last[1] >= last[0] && gap <= maxGapRows) {
                merged.pop();
                merged[0] = [last[0], first[1]];
            }
        }

        const sectors: BlockedSector[] = merged.map(run => {
            const rs = CesiumRadarCoverage.runRows(run, rows);
            let nearest = Infinity, clear = -90;
            for (const r of rs) {
                if (tips.hit[r]) nearest = Math.min(nearest, tips.dist[r]);
                clear = Math.max(clear, tips.clearDeg[r]);
            }
            const widthDeg = Math.min(zone.azimuthWidthDeg, rs.length * rowStepDeg);
            return {
                fromDeg: norm(rowAz[run[0]] - rowStepDeg / 2),
                toDeg: norm(rowAz[run[1]] + rowStepDeg / 2),
                widthDeg,
                nearestHitM: nearest,
                clearDeg: clear,
                // Merging small gaps can make a sector wrap all the way round;
                // it is only "all round" when no direction in it is clear.
                allRound: grid.wrap && rs.length >= rows && rs.every(r => tips.hit[r])
            };
        });
        sectors.sort((a, b) => b.widthDeg - a.widthDeg);

        let blockedRows = 0, allClear = -90;
        for (let r = 0; r < rows; r++) {
            blockedRows += tips.hit[r];
            allClear = Math.max(allClear, tips.clearDeg[r]);
        }

        // Horizon profile, binned (highest clear angle in each bin).
        const bins = Math.min(HORIZON_BINS, rows);
        const horizon = Array.from({ length: bins }, (_, b) => {
            const r0 = Math.floor((b * rows) / bins), r1 = Math.floor(((b + 1) * rows) / bins);
            let c = -90;
            for (let r = r0; r < Math.max(r1, r0 + 1); r++) c = Math.max(c, tips.clearDeg[r]);
            return { azDeg: rowAz[Math.min(rows - 1, Math.floor((r0 + r1) / 2))], clearDeg: c };
        });

        return {
            elevationDeg,
            startDeg: zone.azimuthStartDeg,
            widthDeg: zone.azimuthWidthDeg,
            range: zone.range,
            clearPct: (100 * (rows - blockedRows)) / rows,
            allClearDeg: allClear,
            sectors,
            horizon
        };
    }

    // -------------------------------------------------------------------
    // 4. The beam sheet: buildBeam
    // -------------------------------------------------------------------
    // One surface at the beam's angle: every direction's ray runs out until
    // it meets the terrain or to the full range. Directions that run the full
    // range are green, directions stopped by terrain are red. The edge line
    // joins the ray tips: in the air at the far end, or on the hill that
    // stops the beam.
    private static buildBeam(
        viewer: Cesium.Viewer,
        entityId: string,
        grid: RayGrid,
        tips: BeamTips,
        radarHeight: number,
        angle: number,
        lastCol: number
    ): RadarCoverageHandle & { setStyle(st: RadarStyle): void } {
        const { wrap, profiles } = grid;
        const rows = profiles.length;
        const R = Math.min(rows, BEAM_MESH_MAX_ROWS);
        const rowIdx = Array.from({ length: R }, (_, k) => wrap
            ? Math.floor((k * rows) / R)
            : Math.round((k * (rows - 1)) / Math.max(1, R - 1)));
        const C = BEAM_RAY_POINTS;

        const rayPoint = (row: number, d: number) => {
            const g = CesiumRadarCoverage.groundAt(grid, row, d, lastCol);
            const onGround = tips.hit[row] && d >= tips.dist[row];
            return Cesium.Cartesian3.fromRadians(g.lon, g.lat,
                onGround ? g.height : CesiumRadarCoverage.beamHeightAt(angle, d, radarHeight));
        };

        const positions = new Float64Array(R * C * 3);
        const blockedVertex = new Uint8Array(R * C);
        for (let k = 0; k < R; k++) {
            const row = rowIdx[k];
            for (let j = 0; j < C; j++) {
                const p = rayPoint(row, (tips.dist[row] * j) / (C - 1));
                positions.set([p.x, p.y, p.z], (k * C + j) * 3);
                blockedVertex[k * C + j] = tips.hit[row];
            }
        }
        const indices: number[] = [];
        for (let k = 0; k < (wrap ? R : R - 1); k++) {
            const k2 = (k + 1) % R;
            for (let j = 0; j < C - 1; j++) {
                const p00 = k * C + j, p01 = p00 + 1, p10 = k2 * C + j, p11 = p10 + 1;
                indices.push(p00, p01, p10, p01, p11, p10);
            }
        }
        const indexArray = new Uint32Array(indices);
        const boundingSphere = Cesium.BoundingSphere.fromVertices(Array.from(positions));

        // Tip line, split into clear (green, in the air) and blocked (red, on
        // the terrain) stretches.
        const tipLines = viewer.scene.primitives.add(new Cesium.PolylineCollection()) as Cesium.PolylineCollection;
        // Every polyline needs its own material: a PolylineCollection destroys
        // each line's material when it is removed, so a shared one would be
        // destroyed twice and throw, leaving the rest of the old beam behind.
        const lineMaterial = (color: Cesium.Color) => Cesium.Material.fromType("Color", { color });
        const tipOf = (row: number) => rayPoint(row, tips.dist[row]);
        let k = 0;
        while (k < R) {
            const state = tips.hit[rowIdx[k]];
            const pts = [tipOf(rowIdx[k])];
            let next = k + 1;
            while (next < R && tips.hit[rowIdx[next]] === state) pts.push(tipOf(rowIdx[next++]));
            // Close the line to the next stretch (or back round to the start).
            if (next < R) pts.push(tipOf(rowIdx[next]));
            else if (wrap) pts.push(tipOf(rowIdx[0]));
            if (pts.length >= 2) tipLines.add({ positions: pts, width: 2.5, material: lineMaterial(state ? BLOCKED_COLOR : CLEAR_COLOR) });
            k = next;
        }
        // Range rings: drawn only over directions the beam reaches that far.
        for (const fraction of RANGE_RING_FRACTIONS) {
            const d = grid.zone.range * fraction;
            let ring: Cesium.Cartesian3[] = [];
            const flush = () => {
                if (ring.length >= 2) tipLines.add({ positions: ring, width: 1, material: lineMaterial(RANGE_RING_COLOR) });
                ring = [];
            };
            for (let k = 0; k <= (wrap ? R : R - 1); k++) {
                const row = rowIdx[k % R];
                if (tips.dist[row] >= d) ring.push(rayPoint(row, d));
                else flush();
            }
            flush();
        }

        // Side edges (beam < 360°).
        if (!wrap) {
            for (const row of [rowIdx[0], rowIdx[R - 1]]) {
                tipLines.add({
                    positions: Array.from({ length: C }, (_, j) => rayPoint(row, (tips.dist[row] * j) / (C - 1))),
                    width: 1.5,
                    material: lineMaterial(CLEAR_COLOR)
                });
            }
        }

        const mesh = CesiumRadarCoverage.coloredMesh(viewer, entityId, positions, indexArray, boundingSphere,
            v => [blockedVertex[v] ? BLOCKED_RGB : CLEAR_RGB,
                BEAM_NEAR_ALPHA + (1 - BEAM_NEAR_ALPHA) * ((v % C) / (C - 1))]);

        return {
            dispose: () => {
                mesh.dispose();
                viewer.scene.primitives.remove(tipLines);
            },
            setStyle: (st: RadarStyle) => {
                mesh.draw(st.showBeam ? Cesium.Math.clamp(st.beamOpacity, 0, 1) : 0);
                tipLines.show = st.showBeam;
            }
        };
    }

    // A triangle mesh with a colour per vertex, redrawn when its opacity
    // changes. colorOf gives each vertex's colour and its alpha relative to
    // the opacity passed to draw.
    private static coloredMesh(
        viewer: Cesium.Viewer,
        entityId: string,
        positions: Float64Array,
        indices: Uint32Array,
        boundingSphere: Cesium.BoundingSphere,
        colorOf: (v: number) => [number[], number]
    ): { draw(opacity: number): void; dispose(): void } {
        const vertexCount = positions.length / 3;
        let primitive: Cesium.Primitive | null = null;
        let builtOpacity = -1;
        let disposed = false;
        const remove = () => {
            if (primitive) viewer.scene.primitives.remove(primitive);
            primitive = null;
        };
        return {
            dispose: () => {
                disposed = true;
                remove();
            },
            draw: (opacity: number) => {
                if (disposed || opacity === builtOpacity) return;
                builtOpacity = opacity;
                remove();
                if (indices.length === 0 || opacity <= 0) return;
                const colors = new Uint8Array(vertexCount * 4);
                for (let v = 0; v < vertexCount; v++) {
                    const [rgb, alpha] = colorOf(v);
                    colors.set([rgb[0], rgb[1], rgb[2], Math.round(255 * Math.min(1, opacity * alpha))], v * 4);
                }
                primitive = viewer.scene.primitives.add(new Cesium.Primitive({
                    geometryInstances: new Cesium.GeometryInstance({
                        geometry: new Cesium.Geometry({
                            attributes: {
                                position: new Cesium.GeometryAttribute({
                                    componentDatatype: Cesium.ComponentDatatype.DOUBLE,
                                    componentsPerAttribute: 3,
                                    values: positions
                                }),
                                // Per-vertex colour, read by PerInstanceColorAppearance's "color" input.
                                color: new Cesium.GeometryAttribute({
                                    componentDatatype: Cesium.ComponentDatatype.UNSIGNED_BYTE,
                                    componentsPerAttribute: 4,
                                    normalize: true,
                                    values: colors
                                })
                            } as any,
                            indices,
                            primitiveType: Cesium.PrimitiveType.TRIANGLES,
                            boundingSphere
                        })
                    }),
                    appearance: new Cesium.PerInstanceColorAppearance({ flat: true, translucent: true, closed: false }),
                    asynchronous: false
                })) as Cesium.Primitive;
                (primitive as any).radarParentId = entityId;
            }
        };
    }

    // -------------------------------------------------------------------
    // 4b. Every lower angle, from the floor up to the beam: buildLowerBeams
    // -------------------------------------------------------------------
    // Rays at every level between the floor angle (0°) and the beam's angle,
    // each traced until it meets the terrain or runs the full range:
    //   - floor: the sheet at the floor angle (faint)
    //   - end wall: every ray tip joined to its neighbours up/down and
    //     left/right. Red where the rays stop on a hill, green where they run
    //     the full range, so the hills that cut into the lower angles show.
    //   - side walls (beam < 360°): the rays of the two edge directions.
    // The beam's own sheet (buildBeam) is the top. Nothing is drawn when the
    // beam is at or below the floor.
    private static buildLowerBeams(
        viewer: Cesium.Viewer,
        entityId: string,
        grid: RayGrid,
        radarHeight: number,
        floorDeg: number,
        topDeg: number,
        lastCol: number
    ): RadarCoverageHandle & { setStyle(st: RadarStyle): void } {
        const span = topDeg - floorDeg;
        if (span < 0.01) return { dispose: () => { }, setStyle: () => { } };

        const { wrap, profiles } = grid;
        const rows = profiles.length;
        const R = Math.min(rows, BEAM_MESH_MAX_ROWS);
        const rowIdx = Array.from({ length: R }, (_, k) => wrap
            ? Math.floor((k * rows) / R)
            : Math.round((k * (rows - 1)) / Math.max(1, R - 1)));
        const M = Cesium.Math.clamp(Math.ceil(span / LOWER_LEVEL_STEP_DEG) + 1, 2, LOWER_MAX_LEVELS);
        const angles = Array.from({ length: M }, (_, k) => Cesium.Math.toRadians(floorDeg + (span * k) / (M - 1)));
        const C = BEAM_RAY_POINTS;

        const len = new Float64Array(R * M);
        const hit = new Uint8Array(R * M);
        for (let r = 0; r < R; r++) {
            for (let k = 0; k < M; k++) {
                const tip = CesiumRadarCoverage.rayTip(grid, rowIdx[r], angles[k], lastCol);
                len[r * M + k] = tip.dist;
                hit[r * M + k] = tip.hit ? 1 : 0;
            }
        }
        const rayPoint = (r: number, k: number, d: number) => {
            const g = CesiumRadarCoverage.groundAt(grid, rowIdx[r], d, lastCol);
            const onGround = hit[r * M + k] && d >= len[r * M + k];
            return Cesium.Cartesian3.fromRadians(g.lon, g.lat,
                onGround ? g.height : CesiumRadarCoverage.beamHeightAt(angles[k], d, radarHeight));
        };
        const along = (r: number, k: number, j: number) => rayPoint(r, k, (len[r * M + k] * j) / (C - 1));

        const positions: number[] = [];
        const colors: [number[], number][] = [];
        const indices: number[] = [];
        const addGrid = (na: number, nb: number, wrapA: boolean,
            pointOf: (a: number, b: number) => Cesium.Cartesian3,
            colorOf: (a: number, b: number) => [number[], number]) => {
            const first = positions.length / 3;
            for (let a = 0; a < na; a++) {
                for (let b = 0; b < nb; b++) {
                    const p = pointOf(a, b);
                    positions.push(p.x, p.y, p.z);
                    colors.push(colorOf(a, b));
                }
            }
            for (let a = 0; a < (wrapA ? na : na - 1); a++) {
                const a2 = (a + 1) % na;
                for (let b = 0; b < nb - 1; b++) {
                    const p00 = first + a * nb + b, p01 = p00 + 1, p10 = first + a2 * nb + b, p11 = p10 + 1;
                    indices.push(p00, p01, p10, p01, p11, p10);
                }
            }
        };
        const tipColor = (r: number, k: number): [number[], number] =>
            [hit[r * M + k] ? BLOCKED_RGB : CLEAR_RGB, LOWER_WALL_ALPHA];

        // Floor sheet.
        addGrid(R, C, wrap, (r, j) => along(r, 0, j),
            r => [hit[r * M] ? BLOCKED_RGB : CLEAR_RGB, LOWER_FLOOR_ALPHA]);
        // End wall: every ray tip joined to its neighbours.
        addGrid(R, M, wrap, (r, k) => rayPoint(r, k, len[r * M + k]), tipColor);
        // Side walls.
        if (!wrap) {
            for (const r of [0, R - 1]) {
                addGrid(M, C, false, (k, j) => along(r, k, j), () => [CLEAR_RGB, LOWER_FLOOR_ALPHA]);
            }
        }

        const mesh = CesiumRadarCoverage.coloredMesh(viewer, entityId, new Float64Array(positions),
            new Uint32Array(indices), Cesium.BoundingSphere.fromVertices(positions), v => colors[v]);

        // Floor edge line: the tips of the floor-angle rays.
        const edgeLines = viewer.scene.primitives.add(new Cesium.PolylineCollection()) as Cesium.PolylineCollection;
        const floorTips = Array.from({ length: R }, (_, r) => rayPoint(r, 0, len[r * M]));
        if (wrap) floorTips.push(floorTips[0]);
        edgeLines.add({
            positions: floorTips,
            width: 1.5,
            material: Cesium.Material.fromType("Color", { color: CLEAR_COLOR.withAlpha(0.6) })
        });

        return {
            dispose: () => {
                mesh.dispose();
                viewer.scene.primitives.remove(edgeLines);
            },
            setStyle: (st: RadarStyle) => {
                const show = st.showBeam && st.showLowerBeams;
                mesh.draw(show ? Cesium.Math.clamp(st.beamOpacity, 0, 1) : 0);
                edgeLines.show = show;
            }
        };
    }

    // -------------------------------------------------------------------
    // 5. Ground the beam cannot reach: buildBlockedArea
    // -------------------------------------------------------------------
    // In every blocked direction, the ground from where the beam meets the
    // terrain out to the full range is shaded red (draped on the terrain), and
    // the line where the beam meets the terrain is drawn dark red.
    private static buildBlockedArea(
        viewer: Cesium.Viewer,
        entityId: string,
        grid: RayGrid,
        tips: BeamTips,
        runs: [number, number][],
        lastCol: number
    ): RadarCoverageHandle & { setStyle(st: RadarStyle): void } {
        const rows = tips.hit.length;
        const { rowAz, rowStepDeg, zone } = grid;
        const half = rowStepDeg / 2;
        let fillColor = BLOCKED_COLOR.withAlpha(DEFAULT_RADAR_STYLE.blockedOpacity);
        let reachColor = CLEAR_COLOR.withAlpha(DEFAULT_RADAR_STYLE.blockedOpacity * REACH_ALPHA);
        const material = new Cesium.ColorMaterialProperty(new Cesium.CallbackProperty(() => fillColor, false));
        const fills: Cesium.Entity[] = [];
        const hitLines: Cesium.Cartesian3[][] = [];

        // Green: the ground under the beam, from the radar out to where the
        // beam ends in each direction (the full range, or the hill it hits).
        // It meets the red exactly at the hit line, so inside the range every
        // spot is either green (the beam passes over it) or red (cut off).
        const tipRing = Array.from({ length: rows }, (_, r) =>
            CesiumRadarCoverage.planePoint(grid, rowAz[r], tips.dist[r]));
        const reachPositions = grid.wrap
            ? tipRing
            : [
                CesiumRadarCoverage.planePoint(grid, 0, 0),
                CesiumRadarCoverage.planePoint(grid, rowAz[0] - half, tips.dist[0]),
                ...tipRing,
                CesiumRadarCoverage.planePoint(grid, rowAz[rows - 1] + half, tips.dist[rows - 1])
            ];
        const reach = viewer.entities.add({
            polygon: {
                hierarchy: new Cesium.PolygonHierarchy(reachPositions),
                material: new Cesium.ColorMaterialProperty(new Cesium.CallbackProperty(() => reachColor, false)),
                classificationType: Cesium.ClassificationType.TERRAIN
            }
        });
        (reach as any).radarParentId = entityId;

        const arc = (fromAz: number, toAz: number) => {
            const steps = Math.max(1, Math.ceil(Math.abs(toAz - fromAz) / ARC_STEP_DEG));
            return Array.from({ length: steps + 1 }, (_, s) =>
                CesiumRadarCoverage.planePoint(grid, fromAz + ((toAz - fromAz) * s) / steps, zone.range));
        };
        const hitPoint = (row: number) => {
            const g = CesiumRadarCoverage.groundAt(grid, row, tips.dist[row], lastCol);
            return Cesium.Cartesian3.fromRadians(g.lon, g.lat, g.height);
        };

        viewer.entities.suspendEvents();
        for (const run of runs) {
            const rs = CesiumRadarCoverage.runRows(run, rows);
            // Unwrapped azimuths so a run crossing north stays continuous.
            const azs = rs.map((_, k) => rowAz[rs[0]] + k * rowStepDeg);
            const fullRing = grid.wrap && rs.length === rows;
            let hierarchy: Cesium.PolygonHierarchy;
            if (fullRing) {
                const inner = rs.map((r, k) => CesiumRadarCoverage.planePoint(grid, azs[k], tips.dist[r]));
                hierarchy = new Cesium.PolygonHierarchy(arc(0, 360).slice(0, -1), [new Cesium.PolygonHierarchy(inner)]);
            } else {
                const first = rs[0], last = rs[rs.length - 1];
                const inner = [
                    CesiumRadarCoverage.planePoint(grid, azs[0] - half, tips.dist[first]),
                    ...rs.map((r, k) => CesiumRadarCoverage.planePoint(grid, azs[k], tips.dist[r])),
                    CesiumRadarCoverage.planePoint(grid, azs[azs.length - 1] + half, tips.dist[last])
                ];
                hierarchy = new Cesium.PolygonHierarchy([...inner, ...arc(azs[azs.length - 1] + half, azs[0] - half)]);
            }
            const fill = viewer.entities.add({
                polygon: {
                    hierarchy,
                    material,
                    classificationType: Cesium.ClassificationType.TERRAIN
                }
            });
            (fill as any).radarParentId = entityId;
            fills.push(fill);

            const line = rs.map(hitPoint);
            if (fullRing) line.push(line[0]);
            if (line.length >= 2) hitLines.push(line);
        }
        viewer.entities.resumeEvents();

        const lineMaterial = Cesium.Material.fromType("Color", { color: HIT_LINE_COLOR });
        const outline = hitLines.length === 0 ? null : viewer.scene.primitives.add(new Cesium.GroundPolylinePrimitive({
            geometryInstances: hitLines.map(positions => new Cesium.GeometryInstance({
                geometry: new Cesium.GroundPolylineGeometry({ positions, width: 3 })
            })),
            appearance: new Cesium.PolylineMaterialAppearance({ material: lineMaterial }),
            classificationType: Cesium.ClassificationType.TERRAIN,
            asynchronous: false
        })) as Cesium.GroundPolylinePrimitive | null;

        return {
            dispose: () => {
                viewer.entities.suspendEvents();
                for (const f of fills) viewer.entities.remove(f);
                viewer.entities.remove(reach);
                viewer.entities.resumeEvents();
                if (outline) viewer.scene.primitives.remove(outline);
            },
            setStyle: (st: RadarStyle) => {
                const opacity = Cesium.Math.clamp(st.blockedOpacity, 0, 1);
                fillColor = BLOCKED_COLOR.withAlpha(opacity);
                reachColor = CLEAR_COLOR.withAlpha(opacity * REACH_ALPHA);
                for (const f of fills) f.show = st.showBlocked && opacity > 0;
                reach.show = st.showBlocked && opacity > 0;
                if (outline) outline.show = st.showBlocked;
            }
        };
    }

    // -------------------------------------------------------------------
    // 5b. Ground footprint: buildFootprint
    // -------------------------------------------------------------------
    // An image draped on the terrain over the beam's area: green where the
    // radar has a clear line of sight to the ground, dark where nearer
    // terrain hides it. Each pixel blends the nearest directions and range
    // samples, so the edges run smoothly. It depends only on the radar's
    // spot, mast, range and width (not the angle), so it is cached.
    private static readonly footprintCache = new Map<string, { canvas: HTMLCanvasElement; rectangle: Cesium.Rectangle } | null>();

    private static buildFootprint(
        viewer: Cesium.Viewer,
        entityId: string,
        grid: RayGrid,
        longitude: number,
        latitude: number,
        cacheKey: string
    ): RadarCoverageHandle & { setStyle(st: RadarStyle): void } {
        const cache = CesiumRadarCoverage.footprintCache;
        let image = cache.get(cacheKey);
        if (image === undefined) {
            image = CesiumRadarCoverage.drawFootprint(grid, longitude, latitude);
            while (cache.size >= FOOTPRINT_CACHE_SIZE) cache.delete(cache.keys().next().value!);
        } else {
            cache.delete(cacheKey);
        }
        cache.set(cacheKey, image);
        if (!image) return { dispose: () => { }, setStyle: () => { } };

        let fillColor = Cesium.Color.WHITE.withAlpha(DEFAULT_RADAR_STYLE.footprintOpacity);
        const fill = viewer.entities.add({
            rectangle: {
                coordinates: image.rectangle,
                material: new Cesium.ImageMaterialProperty({
                    image: image.canvas,
                    transparent: true,
                    color: new Cesium.CallbackProperty(() => fillColor, false)
                }),
                classificationType: Cesium.ClassificationType.TERRAIN
            }
        });
        (fill as any).radarParentId = entityId;

        return {
            dispose: () => { viewer.entities.remove(fill); },
            setStyle: (st: RadarStyle) => {
                const opacity = Cesium.Math.clamp(st.footprintOpacity, 0, 1);
                fillColor = Cesium.Color.WHITE.withAlpha(opacity);
                fill.show = st.showFootprint && opacity > 0;
            }
        };
    }

    private static drawFootprint(grid: RayGrid, longitude: number, latitude: number) {
        const { zone, wrap, profiles, rays, rowStepDeg } = grid;
        const rows = rays.length;
        const dists = profiles[0].horizontalDistances;
        const n = dists.length;
        const spacing = n > 1 ? dists[1] - dists[0] : TERRAIN_SAMPLE_SPACING_M;
        const range = zone.range;
        const clampM = FOOTPRINT_SCORE_CLAMP_M;

        // Per direction and sample: how far (metres) the ground rises above
        // the line of sight over the nearer terrain (> 0 seen, < 0 hidden).
        const seen = rays.map(({ groundAngle, peakAngle }) => {
            const out = new Float32Array(n).fill(clampM);
            for (let i = 1; i < n; i++) {
                const d = dists[i];
                if (d < NEAR_FIELD_IGNORE_M || !Number.isFinite(peakAngle[i - 1])) continue;
                out[i] = Cesium.Math.clamp(
                    (Math.tan(groundAngle[i]) - Math.tan(peakAngle[i - 1])) * d, -clampM, clampM);
            }
            return out;
        });
        const scoreAt = (row: number, col: number) => {
            const r0 = Math.floor(row), w = row - r0;
            const c0 = Math.min(Math.floor(col), n - 1), c1 = Math.min(c0 + 1, n - 1), u = col - Math.floor(col);
            const rowScore = (r: number) => {
                if (wrap) r = ((r % rows) + rows) % rows;
                else r = Cesium.Math.clamp(r, 0, rows - 1);
                const sc = seen[r];
                return sc[c0] * (1 - u) + sc[c1] * u;
            };
            return rowScore(r0) * (1 - w) + rowScore(r0 + 1) * w;
        };

        // Bounding box of the beam's area, in metres east / north of the radar.
        const azList: number[] = [];
        for (let k = 0; k <= 64; k++) azList.push(zone.azimuthStartDeg + (zone.azimuthWidthDeg * k) / 64);
        for (let a = 0; a < 360; a += 90) {
            const rel = (((a - zone.azimuthStartDeg) % 360) + 360) % 360;
            if (wrap || rel <= zone.azimuthWidthDeg) azList.push(a);
        }
        let minE = 0, maxE = 0, minN = 0, maxN = 0;
        for (const az of azList) {
            const rad = Cesium.Math.toRadians(az);
            minE = Math.min(minE, Math.sin(rad) * range);
            maxE = Math.max(maxE, Math.sin(rad) * range);
            minN = Math.min(minN, Math.cos(rad) * range);
            maxN = Math.max(maxN, Math.cos(rad) * range);
        }
        const widthM = Math.max(1, maxE - minE);
        const heightM = Math.max(1, maxN - minN);
        const mpp = Math.max(Math.max(widthM, heightM) / FOOTPRINT_TEXTURE_MAX_PX, spacing / 2);
        const texW = Math.max(1, Math.min(FOOTPRINT_TEXTURE_MAX_PX, Math.ceil(widthM / mpp)));
        const texH = Math.max(1, Math.min(FOOTPRINT_TEXTURE_MAX_PX, Math.ceil(heightM / mpp)));
        const mppX = widthM / texW, mppY = heightM / texH;

        const canvas = document.createElement("canvas");
        canvas.width = texW;
        canvas.height = texH;
        const ctx = canvas.getContext("2d");
        if (!ctx) return null;
        const img = ctx.createImageData(texW, texH);
        const data = img.data;
        for (let y = 0; y < texH; y++) {
            // Row 0 is the north edge.
            const north = maxN - (y + 0.5) * mppY;
            for (let x = 0; x < texW; x++) {
                const east = minE + (x + 0.5) * mppX;
                const dist = Math.hypot(east, north);
                if (dist > range || dist < NEAR_FIELD_IGNORE_M) continue;
                const az = (Cesium.Math.toDegrees(Math.atan2(east, north)) + 360) % 360;
                const rel = (((az - zone.azimuthStartDeg) % 360) + 360) % 360;
                if (!wrap && rel > zone.azimuthWidthDeg) continue;
                const s = scoreAt(rel / rowStepDeg, dist / spacing);
                const rgb = s > 0 ? SEEN_RGB : HIDDEN_RGB;
                const o = (y * texW + x) * 4;
                data[o] = rgb[0];
                data[o + 1] = rgb[1];
                data[o + 2] = rgb[2];
                // Soft edge where seen meets hidden.
                data[o + 3] = Math.round(255 * Math.min(1, 0.35 + Math.abs(s) / 2));
            }
        }
        ctx.putImageData(img, 0, 0);

        // WGS84 metres per degree at this latitude.
        const phi = Cesium.Math.toRadians(latitude);
        const metersPerDegLat = 111132.92 - 559.82 * Math.cos(2 * phi) + 1.175 * Math.cos(4 * phi);
        const metersPerDegLon = 111412.84 * Math.cos(phi) - 93.5 * Math.cos(3 * phi);
        const rectangle = Cesium.Rectangle.fromDegrees(
            longitude + minE / metersPerDegLon,
            latitude + minN / metersPerDegLat,
            longitude + maxE / metersPerDegLon,
            latitude + maxN / metersPerDegLat
        );
        return { canvas, rectangle };
    }

    // -------------------------------------------------------------------
    // 6. Labels on the widest blocked sectors: buildSectorLabels
    // -------------------------------------------------------------------
    // Placed where the beam first meets the terrain in the sector: bearing
    // range and compass direction, distance, and the angle that clears it.
    private static buildSectorLabels(
        viewer: Cesium.Viewer,
        entityId: string,
        grid: RayGrid,
        tips: BeamTips,
        sectors: BlockedSector[],
        lastCol: number
    ): RadarCoverageHandle & { setStyle(st: RadarStyle): void } {
        const labels = viewer.scene.primitives.add(new Cesium.LabelCollection()) as Cesium.LabelCollection;
        const rows = tips.hit.length;
        for (const sector of sectors.filter(sc => sc.widthDeg >= MIN_LABEL_WIDTH_DEG).slice(0, MAX_SECTOR_LABELS)) {
            // The direction in this sector where the beam hits nearest.
            let best = -1;
            for (let r = 0; r < rows; r++) {
                if (!tips.hit[r] || tips.dist[r] !== sector.nearestHitM) continue;
                const rel = (((grid.rowAz[r] - sector.fromDeg) % 360) + 360) % 360;
                if (rel <= sector.widthDeg + grid.rowStepDeg) { best = r; break; }
            }
            if (best < 0) continue;
            // In the middle of the sector, out in its red area: past the hit,
            // and at least LABEL_MIN_RANGE_FRACTION of the range out, so
            // labels of sectors blocked close to the radar do not pile up on it.
            const midRow = sector.allRound ? best : CesiumRadarCoverage.rowNearest(grid,
                sector.fromDeg + sector.widthDeg / 2, best);
            const from = tips.hit[midRow] ? tips.dist[midRow] : sector.nearestHitM;
            const range = grid.zone.range;
            const at = Math.min(range * 0.95, Math.max(from + (range - from) * 0.35, range * LABEL_MIN_RANGE_FRACTION));
            const g = CesiumRadarCoverage.groundAt(grid, midRow, at, lastCol);
            const label = labels.add({
                position: Cesium.Cartesian3.fromRadians(g.lon, g.lat, g.height + 30),
                text: `Blocked ${CesiumRadarCoverage.formatSector(sector)}\n` +
                    `${(sector.nearestHitM / 1000).toFixed(1)} km · clears at ${sector.clearDeg.toFixed(1)}°`,
                font: "12px sans-serif",
                fillColor: Cesium.Color.WHITE,
                showBackground: true,
                backgroundColor: Cesium.Color.fromCssColorString("#7f1d1d").withAlpha(0.85),
                backgroundPadding: new Cesium.Cartesian2(6, 4),
                horizontalOrigin: Cesium.HorizontalOrigin.CENTER,
                verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
                disableDepthTestDistance: Number.POSITIVE_INFINITY
            });
            (label as any).radarParentId = entityId;
        }
        return {
            dispose: () => viewer.scene.primitives.remove(labels),
            setStyle: (st: RadarStyle) => { labels.show = st.showLabels; }
        };
    }

    // Grid row whose direction is nearest this bearing (fallback if none).
    private static rowNearest(grid: RayGrid, bearingDeg: number, fallback: number): number {
        let best = fallback, bestDiff = Infinity;
        grid.rowAz.forEach((az, r) => {
            const diff = Math.abs((((az - bearingDeg) % 360) + 540) % 360 - 180);
            if (diff < bestDiff) { bestDiff = diff; best = r; }
        });
        return best;
    }

    static compassOf(deg: number): string {
        const names = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];
        return names[Math.round((((deg % 360) + 360) % 360) / 22.5) % 16];
    }

    // "42°–87° (NE)": the bearing range and the compass direction of its middle.
    static formatSector(sector: BlockedSector): string {
        const mid = sector.fromDeg + sector.widthDeg / 2;
        if (sector.allRound) return "all round";
        return `${Math.round(sector.fromDeg)}°–${Math.round(sector.toDeg)}° (${CesiumRadarCoverage.compassOf(mid)})`;
    }

    // -------------------------------------------------------------------
    // 7. The rays drawn on screen: buildRays
    // -------------------------------------------------------------------
    // `across` directions spread over the beam's width, traced at the beam's
    // angle. A ray stops where it first meets the ground (orange, with a dot
    // at the hit point) or runs to the full range (light green).
    private static buildRays(
        viewer: Cesium.Viewer,
        grid: RayGrid,
        radarHeight: number,
        angle: number,
        across: number
    ): RadarCoverageHandle & { setStyle(st: RadarStyle): void } {
        const { profiles, wrap } = grid;
        const rows = profiles.length;
        const lastCol = CesiumRadarCoverage.lastColumn(grid);

        const rowSet = new Set<number>();
        if (across === 1) rowSet.add(Math.floor(rows / 2));
        else for (let k = 0; k < across; k++) {
            rowSet.add(wrap ? Math.floor((k * rows) / across) : Math.round((k * (rows - 1)) / (across - 1)));
        }

        const lines = viewer.scene.primitives.add(new Cesium.PolylineCollection()) as Cesium.PolylineCollection;
        const hits = viewer.scene.primitives.add(new Cesium.PointPrimitiveCollection()) as Cesium.PointPrimitiveCollection;
        // One material per line (see buildBeam: shared ones are destroyed twice).
        const hitColor = RAY_HIT_COLOR.withAlpha(0.95);
        const clearColor = RAY_CLEAR_COLOR.withAlpha(0.7);

        for (const r of rowSet) {
            const tip = CesiumRadarCoverage.rayTip(grid, r, angle, lastCol);
            const positions: Cesium.Cartesian3[] = [];
            for (let k = 0; k <= RAY_LINE_POINTS; k++) {
                const d = (tip.dist * k) / RAY_LINE_POINTS;
                const g = CesiumRadarCoverage.groundAt(grid, r, d, lastCol);
                const h = tip.hit && k === RAY_LINE_POINTS ? g.height : CesiumRadarCoverage.beamHeightAt(angle, d, radarHeight);
                positions.push(Cesium.Cartesian3.fromRadians(g.lon, g.lat, h));
            }
            lines.add({ positions, width: tip.hit ? 1.6 : 1.1, material: Cesium.Material.fromType("Color", { color: tip.hit ? hitColor : clearColor }) });

            if (tip.hit) {
                const g = CesiumRadarCoverage.groundAt(grid, r, tip.dist, lastCol);
                hits.add({
                    position: Cesium.Cartesian3.fromRadians(g.lon, g.lat, g.height + 2),
                    pixelSize: 5,
                    color: RAY_HIT_COLOR,
                    outlineColor: Cesium.Color.WHITE,
                    outlineWidth: 1,
                    disableDepthTestDistance: HIT_POINT_ALWAYS_VISIBLE_M
                });
            }
        }

        return {
            dispose: () => {
                viewer.scene.primitives.remove(lines);
                viewer.scene.primitives.remove(hits);
            },
            setStyle: (st: RadarStyle) => {
                lines.show = st.showRays;
                hits.show = st.showRays;
            }
        };
    }

    // -------------------------------------------------------------------
    // 8. Azimuths of the directions across the beam
    // -------------------------------------------------------------------
    private static buildAzimuthList(startDeg: number, sweepDeg: number, stepDeg: number): number[] {
        const sweep = Cesium.Math.clamp(sweepDeg, 1, 360);
        const step = Math.max(0.05, stepDeg);
        const count = Math.max(2, Math.round(sweep / step) + (sweep >= 360 ? 0 : 1));
        const azimuths: number[] = [];
        for (let i = 0; i < count; i++) {
            const raw = startDeg + (sweep * i) / (sweep >= 360 ? count : count - 1);
            azimuths.push(((raw % 360) + 360) % 360);
        }
        return azimuths;
    }

    // -------------------------------------------------------------------
    // 9. Terrain profiles (cached)
    // -------------------------------------------------------------------
    // Sampling terrain is by far the slowest step, and the ground does not change
    // when only the mast height, the beam's angle or a shorter range change.
    // Profiles are therefore kept per radar spot + ray fan, and reused when they
    // already reach far enough.
    private static readonly profileCache = new Map<string, { maxRange: number; profiles: TerrainProfile[] }>();

    private static async getTerrainProfiles(
        terrainProvider: Cesium.TerrainProvider,
        cacheKey: string,
        radarPosition: Cesium.Cartesian3,
        enuMatrix: Cesium.Matrix4,
        azimuthsDeg: number[],
        maxRange: number,
        spacing: number
    ): Promise<TerrainProfile[]> {
        const cache = CesiumRadarCoverage.profileCache;
        const hit = cache.get(cacheKey);
        if (hit && hit.maxRange >= maxRange) {
            cache.delete(cacheKey);
            cache.set(cacheKey, hit);
            return hit.profiles;
        }

        const profiles = await CesiumRadarCoverage.buildTerrainProfiles(
            terrainProvider, radarPosition, enuMatrix, azimuthsDeg, maxRange, spacing
        );
        cache.delete(cacheKey);
        cache.set(cacheKey, { maxRange, profiles });
        while (cache.size > PROFILE_CACHE_SIZE) {
            cache.delete(cache.keys().next().value!);
        }
        return profiles;
    }

    private static async buildTerrainProfiles(
        terrainProvider: Cesium.TerrainProvider,
        radarPosition: Cesium.Cartesian3,
        enuMatrix: Cesium.Matrix4,
        azimuthsDeg: number[],
        maxRange: number,
        spacing: number
    ): Promise<TerrainProfile[]> {
        const sampleCount = Math.max(2, Math.ceil(maxRange / spacing)) + 1;
        const horizontalDistances: number[] = [];
        for (let i = 0; i < sampleCount; i++) {
            horizontalDistances.push(Math.min(i * spacing, maxRange));
        }

        const flatCartographics: Cesium.Cartographic[] = [];
        const scratchPoint = new Cesium.Cartesian3();
        for (const azimuthDeg of azimuthsDeg) {
            const groundRay = CesiumRadarCoverage.makeRay(radarPosition, enuMatrix, azimuthDeg, 0);
            for (const distance of horizontalDistances) {
                const point = Cesium.Ray.getPoint(groundRay, distance, scratchPoint);
                flatCartographics.push(Cesium.Cartographic.fromCartesian(point));
            }
        }

        const sampledTerrain = await Cesium.sampleTerrainMostDetailed(terrainProvider, flatCartographics);

        return azimuthsDeg.map((azimuthDeg, a) => {
            const base = a * sampleCount;
            const groundPoints = sampledTerrain.slice(base, base + sampleCount);
            const groundHeights = groundPoints.map(p => p.height ?? 0);
            return { azimuthDeg, horizontalDistances, groundHeights, groundPoints };
        });
    }

    private static makeRay(
        radarPosition: Cesium.Cartesian3,
        enuMatrix: Cesium.Matrix4,
        azimuthDeg: number,
        elevationDeg: number
    ): Cesium.Ray {
        const azimuth = Cesium.Math.toRadians(azimuthDeg);
        const elevation = Cesium.Math.toRadians(elevationDeg);
        const localDirection = new Cesium.Cartesian3(
            Math.sin(azimuth) * Math.cos(elevation),
            Math.cos(azimuth) * Math.cos(elevation),
            Math.sin(elevation)
        );
        const worldDirection = Cesium.Matrix4.multiplyByPointAsVector(enuMatrix, localDirection, new Cesium.Cartesian3());
        Cesium.Cartesian3.normalize(worldDirection, worldDirection);
        return new Cesium.Ray(radarPosition, worldDirection);
    }

    // -------------------------------------------------------------------
    // 10. Shared line-of-sight maths (also used by CesiumLosProbe)
    // -------------------------------------------------------------------
    static readonly NEAR_FIELD_IGNORE_M = NEAR_FIELD_IGNORE_M;

    // Slope (tan of the elevation angle) of the lowest line from the antenna
    // that passes no more than RIDGE_TOLERANCE_M below the terrain seen at
    // `angle`, `dist` away. A point further out is hidden by that terrain
    // exactly when its own tan(angle) is below this value.
    static horizonTan(angle: number, dist: number): number {
        return Math.tan(angle) - RIDGE_TOLERANCE_M / dist;
    }

    // Elevation angle from the antenna to ground at this height and distance,
    // with the 4/3-Earth curvature drop applied.
    static elevationAngle(groundHeight: number, dist: number, radarHeight: number): number {
        const curvatureDrop = (dist * dist) / (2 * EFFECTIVE_EARTH_RADIUS_M);
        return Math.atan2(groundHeight - curvatureDrop - radarHeight, dist);
    }

    // Height above the ellipsoid of a straight beam leaving the antenna at this
    // elevation angle, after this horizontal distance (inverse of elevationAngle).
    static beamHeightAt(angle: number, dist: number, radarHeight: number): number {
        return radarHeight + dist * Math.tan(angle) + (dist * dist) / (2 * EFFECTIVE_EARTH_RADIUS_M);
    }

    // Ground point at this azimuth and horizontal distance from the radar.
    static groundPointAt(geometry: RadarGeometry, azimuthDeg: number, dist: number): Cesium.Cartographic {
        const ray = CesiumRadarCoverage.makeRay(geometry.radarPosition, geometry.enuMatrix, azimuthDeg, 0);
        return Cesium.Cartographic.fromCartesian(Cesium.Ray.getPoint(ray, dist));
    }
}
