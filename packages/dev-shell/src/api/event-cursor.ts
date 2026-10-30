import type { EventEnvelope } from "@hustradio/dev-shell-contract";

export class EventCursor {
  private ids = new Set<string>();
  private sequences = new Set<number>();
  constructor(public eventId: string | null = null, public sequence = 0) {}

  apply(event: EventEnvelope): boolean {
    if (this.ids.has(event.eventId) || this.sequences.has(event.sequence)) return false;
    if (event.sequence <= this.sequence) return false;
    this.ids.add(event.eventId);
    this.sequences.add(event.sequence);
    this.eventId = event.eventId;
    this.sequence = event.sequence;
    if (this.ids.size > 2000) {
      this.ids = new Set([...this.ids].slice(-1000));
      this.sequences = new Set([...this.sequences].slice(-1000));
    }
    return true;
  }

  reset(eventId: string | null = null, sequence = 0) {
    this.eventId = eventId;
    this.sequence = sequence;
    this.ids.clear();
    this.sequences.clear();
  }
}
