// Category manager — opened from the space tile right-click menu
// or the space-landing settings affordance.  Founder/admin-only
// (PL ≥ 50 in the parent space, since the underlying state event
// `chat.koven.space.categories` is gated on state_default).
//
// Operations:
//   - Add a category (auto-generates a stable id)
//   - Rename a category (id stays the same so per-room references
//     don't break)
//   - Drag-reorder via dnd-kit (the array order on the state event
//     IS the display order)
//   - Delete a category (rooms whose category id was this one fall
//     through to the implicit Uncategorised bucket in the sidebar)
//
// We mutate a local draft of the array as the user works, then
// write the whole thing back as a single state event when they
// hit Save.  Drag-reorder fires the save immediately because
// holding a half-applied order would feel sticky during drag.

import { useEffect, useState } from "react";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { GripVertical, Pencil, Plus, Trash2, X } from "lucide-react";
import type { Space, SpaceId } from "@koven/shared";
import {
	DndContext, PointerSensor, useSensor, useSensors,
	closestCenter, type DragEndEvent,
} from "@dnd-kit/core";
import {
	SortableContext, useSortable, verticalListSortingStrategy,
	arrayMove,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";

export interface SpaceCategoriesSheetProps {
	space: Space | null;
	onClose(): void;
	// Save the full category list (the array order is the display
	// order in the sidebar).  Called on every mutation; the dialog
	// stays open so the user can keep editing.  Errors bubble back
	// through this promise so the dialog can surface them inline.
	onSave(spaceId: SpaceId, categories: Array<{ id: string; name: string }>): Promise<void>;
}

export function SpaceCategoriesSheet({ space, onClose, onSave }: SpaceCategoriesSheetProps) {
	const [draft, setDraft] = useState<Array<{ id: string; name: string }>>([]);
	const [newName, setNewName] = useState("");
	const [editingId, setEditingId] = useState<string | null>(null);
	const [editingName, setEditingName] = useState("");
	const [pending, setPending] = useState(false);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		if (!space) return;
		setDraft(space.categories.slice());
		setNewName("");
		setEditingId(null);
		setEditingName("");
		setError(null);
	}, [space]);

	const sensors = useSensors(useSensor(PointerSensor, {
		activationConstraint: { distance: 6 },
	}));

	async function persist(next: Array<{ id: string; name: string }>) {
		if (!space) return;
		setError(null);
		setPending(true);
		// Optimistic local update so reorder + rename feel instant —
		// the state event will re-emit through sync, but our local
		// draft already shows the result.
		setDraft(next);
		try {
			await onSave(space.id, next);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
			// Roll back to the previous state event's value on failure.
			setDraft(space.categories.slice());
		} finally {
			setPending(false);
		}
	}

	function handleDragEnd(e: DragEndEvent) {
		const { active, over } = e;
		if (!over || active.id === over.id) return;
		const oldIdx = draft.findIndex(c => c.id === active.id);
		const newIdx = draft.findIndex(c => c.id === over.id);
		if (oldIdx < 0 || newIdx < 0) return;
		void persist(arrayMove(draft, oldIdx, newIdx));
	}

	function startRename(id: string) {
		const cat = draft.find(c => c.id === id);
		if (!cat) return;
		setEditingId(id);
		setEditingName(cat.name);
	}
	function commitRename() {
		if (!editingId) return;
		const trimmed = editingName.trim();
		if (!trimmed) {
			setEditingId(null);
			return;
		}
		const next = draft.map(c => c.id === editingId ? { ...c, name: trimmed } : c);
		setEditingId(null);
		void persist(next);
	}
	function cancelRename() {
		setEditingId(null);
		setEditingName("");
	}

	function addCategory() {
		const trimmed = newName.trim();
		if (!trimmed) return;
		const id = generateCategoryId();
		const next = [...draft, { id, name: trimmed }];
		setNewName("");
		void persist(next);
	}

	function deleteCategory(id: string) {
		const next = draft.filter(c => c.id !== id);
		void persist(next);
	}

	const open = !!space;

	return (
		<Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
			<DialogContent className="sm:max-w-md">
				<DialogHeader>
					<DialogTitle>Categories</DialogTitle>
					<DialogDescription>
						Group your rooms into named sections.  Drag to reorder.
						Rooms keep their position when categories are renamed; deleting
						a category leaves its rooms uncategorised.
					</DialogDescription>
				</DialogHeader>

				{error && (
					<div className="text-xs text-destructive border border-destructive/40 bg-destructive/10 rounded px-3 py-2">
						{error}
					</div>
				)}

				<div className="space-y-2">
					{draft.length === 0 ? (
						<div className="text-xs text-muted-foreground italic px-3 py-4 text-center border border-dashed border-border rounded">
							No categories yet.  Add one below to group your rooms.
						</div>
					) : (
						<DndContext
							sensors={sensors}
							collisionDetection={closestCenter}
							onDragEnd={handleDragEnd}
						>
							<SortableContext
								items={draft.map(c => c.id)}
								strategy={verticalListSortingStrategy}
							>
								<div className="space-y-1">
									{draft.map(cat => (
										<CategoryRow
											key={cat.id}
											category={cat}
											isEditing={editingId === cat.id}
											editingName={editingName}
											onEditingNameChange={setEditingName}
											onStartRename={() => startRename(cat.id)}
											onCommitRename={commitRename}
											onCancelRename={cancelRename}
											onDelete={() => deleteCategory(cat.id)}
											disabled={pending}
										/>
									))}
								</div>
							</SortableContext>
						</DndContext>
					)}
				</div>

				<div className="pt-2 flex gap-2 border-t border-border">
					<Input
						value={newName}
						onChange={(e) => setNewName(e.target.value)}
						placeholder="New category name"
						onKeyDown={(e) => {
							if (e.key === "Enter") {
								e.preventDefault();
								addCategory();
							}
						}}
						disabled={pending}
					/>
					<Button
						type="button"
						onClick={addCategory}
						disabled={pending || newName.trim().length === 0}
					>
						<Plus className="h-4 w-4 mr-1.5" />
						Add
					</Button>
				</div>

				<DialogFooter>
					<Button type="button" variant="ghost" onClick={onClose} disabled={pending}>
						Done
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

function CategoryRow({
	category, isEditing, editingName, onEditingNameChange,
	onStartRename, onCommitRename, onCancelRename, onDelete, disabled,
}: {
	category: { id: string; name: string };
	isEditing: boolean;
	editingName: string;
	onEditingNameChange(v: string): void;
	onStartRename(): void;
	onCommitRename(): void;
	onCancelRename(): void;
	onDelete(): void;
	disabled: boolean;
}) {
	const sortable = useSortable({ id: category.id, disabled });
	const style = {
		transform: CSS.Transform.toString(sortable.transform),
		transition: sortable.transition,
		opacity: sortable.isDragging ? 0.5 : 1,
	};
	return (
		<div
			ref={sortable.setNodeRef}
			style={style}
			className="flex items-center gap-2 px-2 py-1.5 rounded-md border border-border bg-card"
		>
			<button
				type="button"
				className="p-1 text-muted-foreground hover:text-foreground cursor-grab active:cursor-grabbing"
				aria-label="Drag to reorder"
				{...sortable.attributes}
				{...sortable.listeners}
			>
				<GripVertical className="h-4 w-4" />
			</button>
			{isEditing ? (
				<Input
					value={editingName}
					onChange={(e) => onEditingNameChange(e.target.value)}
					onKeyDown={(e) => {
						if (e.key === "Enter") {
							e.preventDefault();
							onCommitRename();
						}
						if (e.key === "Escape") {
							e.preventDefault();
							onCancelRename();
						}
					}}
					onBlur={onCommitRename}
					autoFocus
					className="h-7 text-sm"
				/>
			) : (
				<button
					type="button"
					onClick={onStartRename}
					className="flex-1 text-left text-sm truncate hover:text-foreground"
					title="Rename"
				>
					{category.name}
				</button>
			)}
			{!isEditing && (
				<>
					<button
						type="button"
						onClick={onStartRename}
						className="p-1 text-muted-foreground hover:text-foreground"
						aria-label="Rename"
						disabled={disabled}
					>
						<Pencil className="h-3.5 w-3.5" />
					</button>
					<button
						type="button"
						onClick={onDelete}
						className="p-1 text-muted-foreground hover:text-destructive"
						aria-label="Delete"
						disabled={disabled}
					>
						<Trash2 className="h-3.5 w-3.5" />
					</button>
				</>
			)}
			{isEditing && (
				<button
					type="button"
					onClick={onCancelRename}
					className="p-1 text-muted-foreground hover:text-foreground"
					aria-label="Cancel"
				>
					<X className="h-3.5 w-3.5" />
				</button>
			)}
		</div>
	);
}

/** Stable per-category id, 8 chars base36, plenty unique for the
 * cardinality this state event ever sees (dozens at most per
 * space). */
function generateCategoryId(): string {
	const rand = () => Math.random().toString(36).slice(2, 6);
	return `${rand()}${rand()}`;
}
