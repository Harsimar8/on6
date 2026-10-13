import {
  AfterViewInit,
  Component,
  ElementRef,
  OnDestroy,
  ViewChild,
  effect,
  inject
} from '@angular/core';

import { LeafletPlacement } from './LeafletPlacement';
import { MapSyncService } from '../../core/services/MapSync';
import { LeafletEntityRenderer } from './LeafletEntityRenderer';
import { EditorState } from '../../core/state/EditorState';
import { EntityRepository } from '../../core/services/EntityRepository';
import { EntityFactory } from '../../core/factories/EntityFactory';
import { Position } from '../../core/models/Position';
import { LeafletSelection } from "./LeafletSelection";
import { TeamFilterService } from '../../core/services/TeamFilterService';
import { TeamFilter } from '../../core/models/TeamFilter';


import * as L from 'leaflet';

@Component({
  selector: 'app-leaflet-map',
  standalone: true,
  imports: [],
  templateUrl: './leaflet-map.html',
  styleUrl: './leaflet-map.css'
})
export class LeafletMap implements AfterViewInit, OnDestroy {

  constructor(
    private editorState: EditorState,
    private entityRepository: EntityRepository
  ) {

    
    effect(() => {
      
      const state = this.mapSync.state();


if (!this.map) return;
     
      if (state.source === 'leaflet') {
        return;
      }

      const center = this.map.getCenter();

      const zoomDifference =
    Math.abs(this.map.getZoom() - state.zoom);

const latitudeDifference =
    Math.abs(center.lat - state.latitude);

const longitudeDifference =
    Math.abs(center.lng - state.longitude);



     if (

    latitudeDifference < 0.0002 &&
    longitudeDifference < 0.0002 &&
    zoomDifference < 0.05

) {
    return;
}

this.syncing = true;

this.map.setView(
    [state.latitude, state.longitude],
    state.zoom,
    {
        animate: false
    }
);

clearTimeout(this.syncTimeout);

this.syncTimeout = setTimeout(() => {

    this.syncing = false;

}, 100);

    });

    effect(() => {

  const entities = this.entityRepository.all();

  // Read the selected entity so this effect reruns when it changes.
  this.editorState.selectedEntity();

  this.teamFilterService.leafletFilter();

  if (this.renderer) {

    this.renderer.render(entities);

  }

});
  }
  @ViewChild('mapContainer', { static: true })
  mapContainer!: ElementRef<HTMLDivElement>;


  private map!: L.Map;
  private renderer!: LeafletEntityRenderer;
  private readonly mapSync = inject(MapSyncService);
  private placement!: LeafletPlacement;
  private selection!: LeafletSelection;
  private animationFrame?: number;
  private syncing = false;
  private syncTimeout?: ReturnType<typeof setTimeout>;
  // Keeps the map filling its box when the side panel or toolbar is resized.
  private resizeObserver?: ResizeObserver;
  public readonly teamFilterService = inject(TeamFilterService);
  protected readonly TeamFilter = TeamFilter;

  ngAfterViewInit(): void {

    this.initializeMap();

    this.resizeObserver = new ResizeObserver(() => this.map?.invalidateSize());
    this.resizeObserver.observe(this.mapContainer.nativeElement);

  }

  private initializeMap(): void {

    this.map = L.map(this.mapContainer.nativeElement, {
      center: [20.5937, 78.9629],
      zoom: 5
    });
    this.map.on("move", () => {

      if (this.syncing) {
        return;
      }

      const center = this.map.getCenter();

      if (this.animationFrame) {
    cancelAnimationFrame(this.animationFrame);
}

this.animationFrame = requestAnimationFrame(() => {

    this.mapSync.update({

        latitude: center.lat,

        longitude: center.lng,

        zoom: this.map.getZoom(),

        source: 'leaflet'

    });

});

    });

    L.tileLayer(
      'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
      {
        attribution: '&copy; OpenStreetMap contributors'
      }
    ).addTo(this.map);
    this.renderer = new LeafletEntityRenderer(
    this.map,
    this.editorState,
    this.teamFilterService
);
    this.renderer.render(this.entityRepository.all());

    this.placement = new LeafletPlacement(

    this.map,

    this.editorState,

    this.entityRepository

);

this.map.on(

    'click',

    this.placement.onMapClick.bind(this.placement)

);

    setTimeout(() => {
      this.map.invalidateSize();
    }, 500);

  }


  
  public resize(): void {

    this.map.invalidateSize();

  }

  setAllForces(): void {

    this.teamFilterService.setLeafletFilter(
        TeamFilter.All
    );

}

setBlueForces(): void {

    this.teamFilterService.setLeafletFilter(
        TeamFilter.Blue
    );

}

setRedForces(): void {

    this.teamFilterService.setLeafletFilter(
        TeamFilter.Red
    );

}
  ngOnDestroy(): void {

    this.resizeObserver?.disconnect();
    this.map.remove();

  }

}