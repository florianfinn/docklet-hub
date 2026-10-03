import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "use-intl";

import { setHubExternalEndpoint, useHubNetwork, type DockerHost } from "../../domain/hosts";
import { queryKeys } from "../../platform/query/query-keys";
import { createHost } from "./api";
import { Button } from "../../platform/ui/shadcn/button";
import { DialogClose, DialogFooter } from "../../platform/ui/shadcn/dialog";
import { Input } from "../../platform/ui/shadcn/input";
import { Label } from "../../platform/ui/shadcn/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../platform/ui/shadcn/select";
import { CommandLine } from "../../platform/ui/CommandLine";
import { describeCreateHostError } from "./host-errors";

// Die Felder für einen neuen Arm (`internal | external`; `local` gibt es genau
// einmal und entsteht nicht hier, §4).
//
// ⚠️ Dieses Formular steht seit D5 IM DIALOG (`HostCreateDialog.tsx`) und
// nicht mehr als Abschnitt unter der Host-Liste — das Artboard zeigt an dieser
// Stelle einen Knopf „Host hinzufügen" und keine dauerhaft offene Maske
// (docs/design/mockup/container-module.html Z. 140). Deshalb trägt es die
// Fußzeile des Dialogs selbst: die Schaltfläche muss `type="submit"` in DIESEM
// `form` sein, sonst löst die Eingabetaste im Namensfeld nichts aus. Eine
// Fußzeile außerhalb müsste das Absenden über eine Kennung an das Formular
// hängen — mehr Fläche für dasselbe.
//
// ⚠️ Das Auswahlfeld ist seit D5 der Baustein `select` aus D2 und kein
// `select` des Browsers mehr. Bis D4 stand hier die Begründung, ein Radix-
// Aufklapper wäre „die Umgestaltung, die dieser Umbau nicht ist" — für den
// Umbau der Anmeldung stimmte das. D5 IST die Umgestaltung dieser Fläche.

// Die Vorgabe des Agenten für den Basispfad der Bind-Mounts, vorbelegt im
// Feld unten.
//
// ⚠️ Sie steht hier ZUM ZWEITEN MAL — die erste Fassung ist
// `DEFAULT_BIND_BASE_PATH` in `server/src/bootstrap/host-archive-input.ts`.
// Web und Server sind getrennte Pakete und teilen keinen Code; eine Abschrift
// ist deshalb unvermeidlich, ein stilles Auseinanderlaufen nicht:
// `web/tests/host-form-defaults.test.mjs` hält beide Zeichenketten
// gegeneinander und wird rot, sobald eine allein wandert.
export const DEFAULT_BIND_BASE_PATH = "/home/docker";

// Was der zweite Schritt des Dialogs vom ersten wissen muss.
//
// ⚠️ Der Pfad kommt VON HIER und nicht aus der Antwort des Servers: `HostView`
// trägt ihn bewusst nicht (er gehört ins Paket und nicht in die Host-Ansicht,
// #89). Der Dialog braucht ihn trotzdem, um im nächsten Schritt zu sagen,
// WOHIN das Archiv gehört — „in ein Verzeichnis" ist keine Anleitung.
export type HostSetup = { bindBasePath: string };

export function HostForm({ onCreated }: { onCreated: (host: DockerHost, setup: HostSetup) => void }) {
  const t = useTranslations();
  const [name, setName] = useState("");
  const [kind, setKind] = useState<"internal" | "external">("internal");
  const [endpointOverride, setEndpointOverride] = useState("");
  // ⚠️ Beide als Zeichenkette im Zustand und nicht als Zahl. Ein Zahlenfeld,
  // das leer ist, liefert "" — daraus würde mit `Number("")` eine 0, also die
  // Gruppe root, und der Arm bekäme ein Paket mit einer geratenen Angabe. Die
  // Umwandlung passiert deshalb einmal beim Absenden, mit einer Prüfung davor.
  const [dockerGid, setDockerGid] = useState("");
  const [bindBasePath, setBindBasePath] = useState(DEFAULT_BIND_BASE_PATH);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Was der Hub über seine eigene Erreichbarkeit sagt (#4).
  //
  // ⚠️ Ein Fehlschlag hier ist KEIN Fehlschlag des Formulars: `network` bleibt
  // dann `null`, die Zeile „dieser Arm wählt …" fehlt, und angelegt werden kann
  // trotzdem. Die Schranke gegen eine unerreichbare Adresse steht am Server
  // (`requireUsableEndpoint`) und nicht hier — dieses Feld ist die Auskunft,
  // nicht die Sicherung.
  const network = useHubNetwork().data ?? null;
  const queryClient = useQueryClient();
  const [remember, setRemember] = useState(true);

  const override = endpointOverride.trim();
  // ⚠️ Nur für `external` gereicht. Ein interner Arm steht im selben Netz wie
  // der Hub; ihm die Adresse von außen zu geben hieße, seinen Tunnel über das
  // Internet und die eigene Portfreigabe zu führen statt über zwei Meter Kabel.
  // Dieselbe Fallunterscheidung wie in `enrollment.ts` — und der Server bleibt
  // die Stelle, die entscheidet.
  const target = kind === "external" ? (override || network?.externalTarget) : network?.internalTarget;
  // Verlangt wird die Eingabe genau dann, wenn der Hub sonst eine Adresse
  // ausliefern würde, die von außen nachweislich nicht ankommt — oder gar
  // keine hat. Ohne geladene Auskunft wird nichts verlangt: der Server weist
  // ohnehin ab, und ein Pflichtfeld auf Verdacht wäre schlimmer als keins.
  const needsEndpoint =
    kind === "external" && network !== null && (network.externalTarget === null || network.externalTargetUnreachable);
  // Die Frage nach dem Merken stellt sich nur beim ERSTEN externen Arm: steht
  // die Adresse schon im Hub, ist eine Eingabe hier wieder das, was sie immer
  // war — die Ausnahme für genau diesen Arm.
  const offerRemember = kind === "external" && override !== "" && network?.externalEndpoint == null;

  const submit = () => {
    // ⚠️ `Number.isInteger` auf dem getrimmten Text und nicht `Number(x) >= 0`:
    // `Number("")` ist 0 und `Number(" ")` auch. Ohne diese Schranke ginge ein
    // leeres Feld als Gruppe root hinaus — und der Agent auf dem Zielhost
    // dürfte den Socket nicht lesen, ohne dass jemand wüsste, warum.
    const gid = Number(dockerGid.trim());
    if (dockerGid.trim() === "" || !Number.isInteger(gid) || gid < 0) {
      setError(t("hostDockerGidInvalid"));
      return;
    }
    if (needsEndpoint && override === "") {
      setError(t("hostEndpointRequired"));
      return;
    }
    setBusy(true);
    setError(null);
    // ⚠️ EINMAL gerechnet und zweimal verwendet: derselbe Wert geht an den
    // Server und an den nächsten Schritt des Dialogs. Zwei Ausdrücke wären
    // zwei Wahrheiten — der Dialog nennte dann bei leerem Feld womöglich einen
    // anderen Pfad als den, der im Paket steht.
    const path = bindBasePath.trim() || DEFAULT_BIND_BASE_PATH;
    // ⚠️ Merken heißt: die Adresse gehört ab jetzt DEM HUB und nicht diesem
    // einen Arm — der `endpointOverride` bleibt deshalb leer. Anders bekäme
    // jeder weitere externe Arm die Adresse aus dem Hub UND dieser eine
    // zusätzlich seine eigene Kopie; wer die Adresse später ändert, änderte sie
    // dann überall außer hier, und genau dieser Arm fiele still aus.
    const keep = offerRemember && remember;
    // Zuerst die Einstellung, dann der Arm: schlägt sie fehl, ist noch nichts
    // angelegt. Umgekehrt stünde ein Arm da, dessen Adresse nirgends steht.
    const prepare = keep
      ? setHubExternalEndpoint(override).then(() =>
          // The address now belongs to the hub: the cached network is stale.
          queryClient.invalidateQueries({ queryKey: queryKeys.settings.hubNetwork() })
        )
      : Promise.resolve();
    prepare
      .then(() =>
        createHost({
          name,
          kind,
          dockerGid: gid,
          bindBasePath: path,
          endpointOverride: keep ? null : override || null
        })
      )
      .then((host) => onCreated(host, { bindBasePath: path }))
      .catch((cause: unknown) => setError(describeCreateHostError(t, cause)))
      .finally(() => setBusy(false));
  };

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      {/* Die Fehlermeldung steht ÜBER den Feldern wie in `AuthCard`: wer
          abgewiesen wird, sieht zuerst, warum, und danach das Feld, das er
          ändern soll. `role="alert"` ist der Grund, warum das kein einfacher
          Absatz ist — der Text erscheint erst nach dem Absenden, und ohne die
          Rolle liest ein Screenreader ihn gar nicht vor. */}
      {error ? (
        <p
          role="alert"
          className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-[9px] text-[13px] text-destructive"
        >
          {error}
        </p>
      ) : null}

      {/* ⚠️ `htmlFor` und `id` an jedem Paar: `Label` aus D2 ist
          `LabelPrimitive.Root` und umschließt sein Feld nicht. */}
      <div className="space-y-2">
        <Label htmlFor="host-name">{t("hostNameLabel")}</Label>
        <Input id="host-name" value={name} onChange={(event) => setName(event.target.value)} required />
      </div>

      <div className="space-y-2">
        <Label htmlFor="host-kind">{t("hostKindFieldLabel")}</Label>
        {/* ⚠️ Radix gibt einen `string` heraus — es kennt unseren Typ nicht.
            Verengt wird an der Wertliste und nicht mit `as`: eine Zusicherung
            wäre eine Behauptung über eine Eingabe, die nicht aus diesem Modul
            kommt. Kommt etwas anderes an, geschieht nichts. */}
        <Select
          value={kind}
          onValueChange={(value) => {
            if (value === "internal" || value === "external") setKind(value);
          }}
        >
          <SelectTrigger id="host-kind" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="internal" data-testid="host-kind-internal">{t("hostKindOptionInternal")}</SelectItem>
            <SelectItem value="external" data-testid="host-kind-external">{t("hostKindOptionExternal")}</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {/* Die zwei Werte, die dem ZIELHOST gehören und die dieser Hub nicht
          herausfinden kann. Beide Hinweise nennen den Befehl, mit dem man sie
          dort abliest — die Frage stellt sich genau einmal, und zwar hier,
          bevor das Paket erzeugt wird. Danach wäre sie ein Handgriff auf einem
          fremden Rechner. */}
      <div className="space-y-2">
        <Label htmlFor="host-docker-gid">{t("hostDockerGidLabel")}</Label>
        <Input
          id="host-docker-gid"
          // ⚠️ `inputMode` statt `type="number"`: ein Zahlenfeld gibt bei einer
          // ungültigen Eingabe "" heraus, und aus "" würde beim Absenden eine
          // 0 — die Gruppe root. Der Text kommt hier so an, wie er dasteht,
          // und wird einmal geprüft.
          inputMode="numeric"
          value={dockerGid}
          placeholder={t("hostDockerGidPlaceholder")}
          aria-describedby="host-docker-gid-hint"
          onChange={(event) => setDockerGid(event.target.value)}
          required
        />
        <span id="host-docker-gid-hint" className="block text-xs text-muted-foreground">
          {t("hostDockerGidHint")}
          <CommandLine>{t("hostDockerGidCommand")}</CommandLine>
        </span>
      </div>

      <div className="space-y-2">
        <Label htmlFor="host-bind-base-path">{t("hostBindBasePathLabel")}</Label>
        <Input
          id="host-bind-base-path"
          value={bindBasePath}
          placeholder={DEFAULT_BIND_BASE_PATH}
          aria-describedby="host-bind-base-path-hint"
          onChange={(event) => setBindBasePath(event.target.value)}
        />
        <span id="host-bind-base-path-hint" className="block text-xs text-muted-foreground">
          {t("hostBindBasePathHint")}
          <CommandLine>{t("hostBindBasePathCommand")}</CommandLine>
        </span>
      </div>

      {/* ⚠️ HIER STAND FÜR JEDE ART DASSELBE FELD. Das war der Fund des
          Betreibers vom 2026-09-07: für einen INTERNEN Arm ist die Adresse des
          Hubs fest — es ist seine Adresse im eigenen Netz —, und ein Feld
          dafür kann nur falsch ausgefüllt werden. Für einen EXTERNEN ist sie
          die eine Angabe, ohne die sein Tunnel nie zustande kommt.

          Ein Feld für beide Fälle stellte deshalb dem einen eine Frage, die er
          nicht beantworten kann, und dem anderen eine, deren Gewicht er nicht
          sah. Es steht jetzt nur noch dort, wo es etwas entscheidet. */}
      {kind === "external" ? (
        <div className="space-y-2">
          <Label htmlFor="host-endpoint-override">{t("hostEndpointOverrideLabel")}</Label>
          <Input
            id="host-endpoint-override"
            value={endpointOverride}
            placeholder={t("hostEndpointOverridePlaceholder")}
            aria-describedby="host-endpoint-override-hint"
            onChange={(event) => setEndpointOverride(event.target.value)}
            required={needsEndpoint}
          />
          <span id="host-endpoint-override-hint" className="block text-xs text-muted-foreground">
            {needsEndpoint ? t("hostEndpointRequiredHint") : t("hostEndpointOverrideHint")}
          </span>
          {offerRemember ? (
            // Die Adresse gehört dem Hub und nicht diesem Arm — merken ist
            // deshalb die Vorgabe und nicht die Ausnahme. Wer sie abwählt, hat
            // einen Grund, und der ist genau das, was „Override" heißt.
            <label className="flex items-start gap-2 pt-1 text-xs text-muted-foreground">
              <input
                type="checkbox"
                className="mt-0.5"
                checked={remember}
                data-testid="host-endpoint-remember"
                onChange={(event) => setRemember(event.target.checked)}
              />
              <span>{t("hostEndpointRememberHint")}</span>
            </label>
          ) : null}
        </div>
      ) : null}

      {/* Die Zeile, die bis hierher fehlte: WELCHE Adresse dieser Arm anwählen
          wird. Sie beantwortet die Frage des Feldes darüber, statt sie zu
          beschreiben — und bei „extern" sieht der Betreiber die private
          Adresse dort stehen, BEVOR er ein Archiv erzeugt, das es nur einmal
          gibt. */}
      {target ? (
        <p className="text-xs text-muted-foreground" data-testid="host-endpoint-target">
          {t("hostEndpointTarget")}
          <CommandLine>{target}</CommandLine>
        </p>
      ) : null}

      <DialogFooter>
        <DialogClose asChild>
          <Button type="button" variant="outline">
            {t("cancel")}
          </Button>
        </DialogClose>
        <Button type="submit" disabled={busy}>
          {busy ? t("loading") : t("hostCreateSubmit")}
        </Button>
      </DialogFooter>
    </form>
  );
}
