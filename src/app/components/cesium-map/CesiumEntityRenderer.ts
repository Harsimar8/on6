import * as Cesium from "cesium";
import { Entity } from "../../core/models/Entity";
import { EntityIconFactory } from "../../core/factories/EntityIconFactory";
import { EditorState } from "../../core/state/EditorState";
import { TeamFilterService } from "../../core/services/TeamFilterService";
import { Team } from "../../core/types/Team";
import { TeamFilter } from "../../core/models/TeamFilter";
import {
    BeamScanResult,
    CesiumRadarCoverage,
    RadarCoverageHandle,
    RadarStyle
} from "./CesiumRadarCoverage";


export class CesiumEntityRenderer {

    // Live radar coverage handles, keyed by source entity.id
    private readonly radarEntities = new Map<string, RadarCoverageHandle[]>();

    // Signature of the exact inputs (position + radar properties) that the
    // currently-built coverage for an entity was generated from. If a
    // render() call comes in and nothing in this signature changed, we skip
    // rebuilding entirely - this is what stops the ray fan from swimming
    // on every camera pan/zoom/selection change.
    private readonly lastBuiltSignature = new Map<string, string>();

    // Guards against overlapping async rebuilds for the same entity
    private readonly buildInFlight = new Set<string>();

    // Latest entity state that arrived while a build was already running. A
    // rebuild takes long enough (terrain sampling per ray) that a drag can
    // easily finish mid-build, so the newest state is parked here and built as
    // soon as the running build finishes - otherwise the drop position would
    // never be rendered at all.
    private readonly pendingRebuild = new Map<string, Entity>();

    // Look-only settings (opacities, ring toggle) last applied to the live
    // coverage. These never trigger a rebuild - they are pushed into the
    // existing handles through setStyle.
    private readonly lastAppliedStyle = new Map<string, string>();

    // Newest entity state seen per radar, so a build that finishes can apply
    // style changes that arrived while it was running.
    private readonly latestEntity = new Map<string, Entity>();

    // Every coverage built for a radar and not yet removed: normally just the
    // one on screen. When a build is put on screen, all the others are removed,
    // so no older beam can ever be left behind.
    private readonly liveBuilds = new Map<string, Set<RadarCoverageHandle[]>>();

    constructor(
        private viewer: Cesium.Viewer,
        private terrainProvider: Cesium.TerrainProvider,
        private teamFilterService: TeamFilterService,
        private editorState: EditorState,
        // Called with what the beam reaches each time a radar is rebuilt.
        private onScan?: (entityId: string, scan: BeamScanResult) => void,
        // Called when a radar starts (true) and finishes (false) rebuilding.
        private onBuilding?: (entityId: string, building: boolean) => void
    ) { }

    render(entities: Entity[]): void {
        const filter = this.teamFilterService.cesiumFilter();
        const seenIds = new Set<string>();

        for (const entity of entities) {

            if (
                (filter === TeamFilter.Blue && entity.team !== Team.Blue) ||
                (filter === TeamFilter.Red && entity.team !== Team.Red)
            ) {
                continue;
            }

            if (entity.definition.entityType === "RadarSite") {
                seenIds.add(entity.id);
                this.syncRadarCoverage(entity);
            }
        }

        // Clean up coverage for radars that no longer exist / no longer pass the filter
        const trackedIds = new Set([
            ...this.radarEntities.keys(),
            ...this.buildInFlight,
            ...this.latestEntity.keys()
        ]);
        for (const existingId of trackedIds) {
            if (!seenIds.has(existingId)) this.removeRadarCoverage(existingId);
        }

        this.viewer.scene.requestRender();
    }

    /** Drops the cached signature so the next render() call rebuilds this radar from scratch. */
    forceRebuild(entityId: string): void {
        this.lastBuiltSignature.delete(entityId);
    }

    private removeRadarCoverage(entityId: string): void {
        this.disposeRadarCoverage(entityId);
        this.pendingRebuild.delete(entityId);
        this.lastAppliedStyle.delete(entityId);
        this.latestEntity.delete(entityId);
    }

    private disposeBuild(entityId: string, handles: RadarCoverageHandle[]): void {
        // One piece failing to go must not leave the others on the map.
        for (const handle of handles) {
            try {
                handle.dispose();
            } catch (err) {
                console.error("Failed to remove part of a radar coverage:", err);
            }
        }
        this.liveBuilds.get(entityId)?.delete(handles);
        // The viewer only redraws on request: without this the removed beam
        // stays on screen until something else (e.g. the camera) moves.
        this.redrawFor();
    }

    // Keeps redrawing for a short while. One redraw is not always enough:
    // newly added beams and draped ground shapes finish setting up over the
    // next frames, and with nothing else asking for a redraw (e.g. at the
    // all-clear angle, where there is no blocked ground left to draw) the new
    // beam would only appear once the camera or a setting changed.
    private redrawFrame: number | null = null;
    private redrawUntil = 0;

    private redrawFor(ms = 1500): void {
        this.redrawUntil = Math.max(this.redrawUntil, performance.now() + ms);
        if (this.redrawFrame !== null) return;
        const tick = () => {
            this.viewer.scene.requestRender();
            this.redrawFrame = performance.now() < this.redrawUntil ? requestAnimationFrame(tick) : null;
        };
        tick();
    }

    /** Removes every build of this radar except `keep`. */
    private disposeBuildsExcept(entityId: string, keep?: RadarCoverageHandle[]): void {
        for (const handles of [...(this.liveBuilds.get(entityId) ?? [])]) {
            if (handles !== keep) this.disposeBuild(entityId, handles);
        }
    }

    private disposeRadarCoverage(entityId: string): void {
        this.disposeBuildsExcept(entityId);
        this.radarEntities.delete(entityId);
        this.lastBuiltSignature.delete(entityId);
    }

    private styleOf(entity: Entity): RadarStyle {
        return CesiumRadarCoverage.styleOf((entity.definition.properties as any) ?? {});
    }

    private applyStyle(entity: Entity): void {
        const style = this.styleOf(entity);
        const key = JSON.stringify(style);
        if (this.lastAppliedStyle.get(entity.id) === key) return;

        for (const handle of this.radarEntities.get(entity.id) ?? []) {
            handle.setStyle?.(style);
        }
        this.lastAppliedStyle.set(entity.id, key);
    }

    private buildSignature(entity: Entity): string {
        const props = (entity.definition.properties as any) ?? {};

        return JSON.stringify({
            lon: entity.position.longitude,
            lat: entity.position.latitude,
            alt: entity.position.altitude,
            // Opacities / show toggles are deliberately not here: they are
            // applied in place by applyStyle.
            beam: CesiumRadarCoverage.beamOf(props),
            azimuthStepDeg: props.azimuthStepDeg
        });
    }

    private async syncRadarCoverage(entity: Entity): Promise<void> {

        const signature = this.buildSignature(entity);
        this.latestEntity.set(entity.id, entity);

        if (this.lastBuiltSignature.get(entity.id) === signature) {
            // Geometry unchanged - at most the look changed, which is cheap.
            // Back to what is on screen: an angle parked meanwhile is stale.
            this.pendingRebuild.delete(entity.id);
            this.applyStyle(entity);
            return;
        }

        // The old coverage goes at once; the new one is drawn when it is ready
        // (the panel shows "Updating radar beam" meanwhile).
        this.disposeRadarCoverage(entity.id);
        this.onBuilding?.(entity.id, true);

        if (this.buildInFlight.has(entity.id)) {
            // Park the newest state; the running build rebuilds from it when
            // it finishes. Older parked states are simply overwritten.
            this.pendingRebuild.set(entity.id, entity);
            return;
        }

        this.buildInFlight.add(entity.id);
        this.onBuilding?.(entity.id, true);

        try {

            const props = (entity.definition.properties as any) ?? {};

            const newHandles = await CesiumRadarCoverage.create3DRadarZones(
                this.viewer,
                this.terrainProvider,
                {
                    entityId: entity.id,
                    longitude: entity.position.longitude,
                    latitude: entity.position.latitude,
                    altitude: entity.position.altitude,
                    beam: CesiumRadarCoverage.beamOf(props),
                    azimuthStepDeg: props.azimuthStepDeg,
                    style: this.styleOf(entity)
                }
            );
            if (!this.liveBuilds.has(entity.id)) this.liveBuilds.set(entity.id, new Set());
            this.liveBuilds.get(entity.id)!.add(newHandles);

            const latest = this.latestEntity.get(entity.id);
            if (!latest || this.buildSignature(latest) !== signature) {
                // Settings changed while it was building: the newer build replaces it.
                this.disposeBuild(entity.id, newHandles);
                return;
            }

            // Put the new build on screen and remove every older one.
            this.disposeBuildsExcept(entity.id, newHandles);
            this.radarEntities.set(entity.id, newHandles);
            this.lastBuiltSignature.set(entity.id, signature);

            const scan = newHandles.find(h => h.scan)?.scan;
            if (scan) this.onScan?.(entity.id, scan);

            // The new build used the style from when it started; bring it up to
            // date with any slider moves made while it was running.
            this.lastAppliedStyle.delete(entity.id);
            this.applyStyle(this.latestEntity.get(entity.id) ?? entity);

            this.redrawFor();

        } catch (err) {
            console.error("Failed to render 3D radar coverage:", err);
        } finally {
            this.buildInFlight.delete(entity.id);

            const pending = this.pendingRebuild.get(entity.id);

            if (pending) {
                this.pendingRebuild.delete(entity.id);
                // Always the newest state, never an older parked one.
                this.syncRadarCoverage(this.latestEntity.get(entity.id) ?? pending);
            }
            this.onBuilding?.(entity.id, this.buildInFlight.has(entity.id));
        }
    }

    private drawRadar(entity: Entity): void {
        const selected =
            this.editorState.selectedEntity()?.id === entity.id;

        this.viewer.entities.add({
            id: entity.id,

            position: Cesium.Cartesian3.fromDegrees(
                entity.position.longitude,
                entity.position.latitude,
                entity.position.altitude
            ),

            billboard: {
                image: EntityIconFactory.get(
                    entity.definition.entityType
                ),

                width: selected ? 36 : 32,
                height: selected ? 36 : 32,

                scale: selected ? 1.08 : 1.0,

                color: selected
                    ? Cesium.Color.fromCssColorString("#FFF8DC")
                    : Cesium.Color.WHITE,

                disableDepthTestDistance: Number.POSITIVE_INFINITY,

                heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,

                verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
                horizontalOrigin: Cesium.HorizontalOrigin.CENTER
            }
        });
    }

    private drawTeamDot(entity: Entity): void {
        this.viewer.entities.add({
            position: Cesium.Cartesian3.fromDegrees(
                entity.position.longitude,
                entity.position.latitude,
                entity.position.altitude
            ),

            billboard: {
                image:
                    entity.team === "Blue"
                        ? "assets/blue.png"
                        : "assets/red.png",

                color:
                    entity.team === "Blue"
                        ? Cesium.Color.fromCssColorString("#3B82F6")
                        : Cesium.Color.WHITE,

                width: 16,
                height: 16,

                heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,

                verticalOrigin: Cesium.VerticalOrigin.CENTER,
                horizontalOrigin: Cesium.HorizontalOrigin.CENTER,

                disableDepthTestDistance: Number.POSITIVE_INFINITY
            }
        });
    }
}