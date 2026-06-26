import { createSignal } from "solid-js";
import "./ConsentModal.css";

/**
 * First-run acknowledgement. Shown once before any generation is possible.
 * Copy is verbatim from FIRST_RUN_ACKNOWLEDGEMENT.md and must not be softened
 * or paraphrased. The modal is non-dismissible: no close button, no backdrop
 * dismiss, no Escape. The continue button is gated on the checkbox.
 */
export function ConsentModal(props: { onAccept: () => void }) {
  const [agreed, setAgreed] = createSignal(false);

  return (
    <div class="modal-backdrop consent-backdrop">
      <div class="consent" role="dialog" aria-modal="true" aria-labelledby="consent-title">
        <header class="editor__header">
          <h2 class="editor__title" id="consent-title">
            Before you start
          </h2>
        </header>

        <div class="consent__body">
          <p>
            Scenecraft generates images and videos of characters built from reference images you
            provide. Before you use it, understand and agree to the following.
          </p>
          <ul class="consent__list">
            <li>
              Use only likenesses you own or have explicit permission to use. For a real person,
              that means their consent.
            </li>
            <li>
              Do not create sexual or intimate imagery of any real person without their consent. In
              many places this is illegal.
            </li>
            <li>
              Never create sexual content involving minors. This is illegal everywhere and is never
              permitted, including when running fully offline.
            </li>
            <li>
              You are solely responsible for what you generate and for following the terms of any
              cloud provider you connect.
            </li>
          </ul>
          <p>
            Running Scenecraft locally removes provider content filters and keeps your data on your
            machine. It does not remove these legal and ethical limits. They apply no matter where
            generation happens.
          </p>

          <label class="consent__check">
            <input
              type="checkbox"
              checked={agreed()}
              onChange={(e) => setAgreed(e.currentTarget.checked)}
            />
            <span>
              I have read this and agree to use Scenecraft only for content I am permitted to
              create.
            </span>
          </label>
        </div>

        <footer class="consent__footer">
          <button
            type="button"
            class="btn btn--primary"
            disabled={!agreed()}
            onClick={props.onAccept}
          >
            Agree and continue
          </button>
        </footer>
      </div>
    </div>
  );
}
