import { Component , inject, signal} from '@angular/core';
import { CommonModule } from '@angular/common';
import { PropertyPanel } from '../property-panel/property-panel';
import { AssetLibraryService } from '../../core/services/AssetLibraryService';
import { EditorState } from '../../core/state/EditorState';
import { TreeNode } from '../tree-node/tree-node';
import { AssetTreeNode } from '../../core/models/AssetTreeNode';

// Property panel height limits (pixels); the tree keeps at least TREE_MIN_PX.
const PANEL_MIN_PX = 80;
const PANEL_DEFAULT_PX = 300;
const TREE_MIN_PX = 120;
const PANEL_HEIGHT_KEY = 'mission-editor.propertyPanelHeight';

@Component({
  selector: 'app-asset-browser',
  standalone: true,
  imports: [
    CommonModule,
    TreeNode,
    PropertyPanel
  ],
  templateUrl: './asset-browser.html',
  styleUrl: './asset-browser.css'
})
export class AssetBrowser {

  private assetLibrary = inject(AssetLibraryService);
  private editorState = inject(EditorState);

  readonly tree = this.assetLibrary.tree;

  // Property panel height, set by dragging the bar above it.
  readonly panelHeight = signal(AssetBrowser.loadPanelHeight());
  readonly dragging = signal(false);

  startResize(event: PointerEvent): void {
    if (event.button !== 0) return;
    event.preventDefault();
    const splitter = event.currentTarget as HTMLElement;
    const maxHeight = Math.max(PANEL_MIN_PX, (splitter.parentElement?.clientHeight ?? 600) - TREE_MIN_PX);
    splitter.setPointerCapture(event.pointerId);
    const startY = event.clientY;
    const startHeight = this.panelHeight();
    this.dragging.set(true);

    const onMove = (e: PointerEvent) => {
      const height = startHeight - (e.clientY - startY);
      this.panelHeight.set(Math.min(maxHeight, Math.max(PANEL_MIN_PX, height)));
    };
    const onUp = (e: PointerEvent) => {
      splitter.releasePointerCapture(e.pointerId);
      splitter.removeEventListener('pointermove', onMove);
      splitter.removeEventListener('pointerup', onUp);
      splitter.removeEventListener('pointercancel', onUp);
      this.dragging.set(false);
      try { localStorage.setItem(PANEL_HEIGHT_KEY, String(this.panelHeight())); } catch { }
    };
    splitter.addEventListener('pointermove', onMove);
    splitter.addEventListener('pointerup', onUp);
    splitter.addEventListener('pointercancel', onUp);
  }

  private static loadPanelHeight(): number {
    try {
      const saved = Number(localStorage.getItem(PANEL_HEIGHT_KEY));
      if (saved >= PANEL_MIN_PX) return saved;
    } catch { }
    return PANEL_DEFAULT_PX;
  }

  selectAsset(assetId: string): void {

    const asset = this.assetLibrary.getAssetById(assetId);

    if (!asset) {
      return;
    }

    this.editorState.selectedAsset.set(asset);

    console.log('Selected Asset:', asset);
  }
}