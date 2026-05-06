import React, { useState } from "react";
import { useNavigate } from "react-router-dom";
import toast from "react-hot-toast";
import { api } from "../utils/api";
import MergePicker from "../components/MergePicker";

// Standalone merge tool. No anchor — admin picks both tickets fresh.
// Sits behind the picker so the page itself stays minimal: when the
// dialog is closed the page is mostly an explanatory hint.
export default function AdminMerge() {
  const navigate = useNavigate();
  const [open, setOpen] = useState(true);

  async function doMerge({ loserId, winnerId }) {
    try {
      const r = await api.post(`/api/tickets/${loserId}/merge`, { winner_id: winnerId });
      toast.success(`${r.loser_ref} merged into ${r.winner_ref}`);
      navigate(`/tickets/${winnerId}`);
    } catch (e) {
      toast.error(e.message);
      throw e;
    }
  }

  return (
    <div className="space-y-4">
      <div className="bg-surface border border-border rounded-lg p-4">
        <h3 className="text-sm font-semibold text-fg mb-1">Merge tickets</h3>
        <p className="text-xs text-fg-muted">
          Search by ticket reference (e.g. <code>WEB-0042</code>), title, or
          description to pick both sides of a merge. Direction (winner / loser)
          is chosen here, not by which ticket you opened first.
        </p>
        <button
          onClick={() => setOpen(true)}
          className="mt-3 btn-primary btn btn-sm"
        >
          Open merge picker
        </button>
      </div>

      <MergePicker
        open={open}
        anchorTicket={null}
        onCancel={() => setOpen(false)}
        onConfirm={async (args) => {
          await doMerge(args);
          setOpen(false);
        }}
      />
    </div>
  );
}
