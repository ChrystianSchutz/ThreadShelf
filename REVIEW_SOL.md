# Review: lokalne API kompatybilne z OpenAI / Anthropic

Porównanie `feat/local-model-api-openai-compatible` (`207a93a`) z lokalnym `main`
(`1c9c96e`), przez `git diff main...HEAD`.

## Status po poprawkach

Wszystkie pięć ustaleń poniżej zostało poprawionych. Idle unload oraz targeted
unload utrzymują blokadę runtime; timer jest ponownie uzbrajany po operacji,
która pozostawia model załadowany. Rozłączenie jest obsługiwane przed lookup
modelu i sprawdzane przed inferencją. Kolizje id otrzymują stabilny hash suffix,
a UI pomija niezmienioną sekcję `llamaCpp` przy zapisywaniu ustawień dostępu.

Dodano 10 testów regresyjnych: 6 unit, 3 API E2E i 1 Playwright. Obejmują powolne
zatrzymywanie, równoległe lease/unload, ponowne uzbrojenie idle, prywatność
i stabilność identyfikatorów, rozłączenie przed rejestracją listenerów, anulowanie
lookup/streamu, zamknięcie aktywnego połączenia sieciowego oraz zmianę ustawień
dostępu z UI podczas generacji. Zmiana parametrów runtime podczas generacji
pozostaje blokowana.

Końcowe `npm run check`: **PASS** — unit **500 passed, 2 skipped** (502 łącznie),
API/MCP E2E **19 passed**, Playwright **72 passed**; repo hygiene, lint,
TypeScript i build klienta również przeszły.

Poniższe ustalenia i liczby w pierwotnej walidacji opisują snapshot `207a93a`.

**Pierwotna rekomendacja: poprawić przed merge.** Potwierdziłem pięć błędów P2 dotyczących
zarządzania runtime, anulowania żądań, katalogu modeli i zapisywania ustawień API.
Nie znalazłem obejścia weryfikacji skonfigurowanego klucza w sprawdzonych ścieżkach.

## 1. [P2] Idle unload pozwala uruchomić drugi proces przed zakończeniem pierwszego

**Miejsce:** `src/generation/llama-process.ts:384–389`.

Callback timera uruchamia `stopCurrentLlamaServer()` bez zajęcia
`withLlamaRuntimeControl` ani ustawienia trwającego przejścia. Funkcja od razu
ustawia `managed = null`, a dopiero później czeka na zakończenie procesu. Żądanie
przychodzące w tym oknie może zająć lease i uruchomić kolejny `llama-server`, mimo
że poprzedni nadal trzyma VRAM/RAM. Dotyczy także ponownego ładowania tego samego
modelu. Na GPU mieszczącym jeden model może to skończyć się błędem braku pamięci.

**Potwierdzenie:** deterministyczny double procesu z prawdziwym endpointem
`/health`, opóźnieniem zakończenia 800 ms i skróconą minutą idle do 100 ms.
Po rozpoczęciu automatycznego zatrzymania wysłałem kolejne żądanie przez
`withLlamaServer`. Maksymalna liczba jednocześnie żywych procesów wyniosła **2**.

**Poprawka:** utrzymywać blokadę sterowania runtime przez całe zatrzymywanie albo
włączyć zatrzymywanie do mechanizmu serializującego przejścia. Nowe ładowanie musi
poczekać na zakończenie poprzedniego procesu lub zwrócić retryable `model_busy`.
Potrzebny test żądania przychodzącego podczas powolnego idle unload.

## 2. [P2] `unload` wskazanego modelu może zwolnić inny model

**Miejsce:** `src/generation/local-api.ts:193–199`.

Odczyt aktualnego modelu i porównanie z żądanym modelem odbywają się poza blokadą
runtime. Pomiędzy nimi a `withLlamaRuntimeControl` jest jeszcze asynchroniczne
`listLocalApiModels()`. W tym czasie inne żądanie może przełączyć model i zakończyć
generację. Następnie `stopManagedLlamaServer` zatrzyma aktualny proces, chociaż
warunek `wanted` sprawdzono względem starego modelu. Odpowiedź również podaje
nieaktualny identyfikator.

**Potwierdzenie:** załadowałem `synthetic`, rozpocząłem
`unloadLocalApiModel('synthetic')` i wstrzymałem drugie odczytanie katalogu modeli.
Następnie załadowałem `other` i zakończyłem jego żądanie. Po odblokowaniu odczytu
unload zatrzymał **`other`**, zwracając
`{ unloaded: true, model: 'synthetic' }`.

**Poprawka:** sprawdzać aktualnie załadowany model i warunek `wanted` wewnątrz tej
samej blokady, która obejmuje zatrzymanie. Rozpoznanie publicznego identyfikatora
może nastąpić wcześniej, ale decyzja musi korzystać z bieżącego stanu runtime.
Potrzebny test przełączenia modelu podczas odczytu katalogu przez unload.

## 3. [P2] Rozłączenie podczas rozpoznawania modelu nie anuluje inferencji

**Miejsce:** `src/routes/local-api.ts:241–246`.

`abortOnDisconnect` zostaje zarejestrowany dopiero po
`await resolveLocalApiModel(...)`. Rozpoznawanie może skanować katalogi albo czekać
na `/v1/models` istniejącego serwera. Jeżeli klient rozłączy się podczas tego
oczekiwania, zdarzenie `res.close` nastąpi przed rejestracją listenera i nie
zostanie odtworzone. Kod później zajmuje lease i przekazuje inferencję z sygnałem,
który nie jest anulowany. Niepotrzebna generacja może zużywać GPU i blokować
przełączenie modelu aż do zakończenia odpowiedzi.

**Potwierdzenie:** izolowany ThreadShelf z syntetycznym upstreamem opóźniającym
odpowiedź `/v1/models` o 600 ms. Po rozpoczęciu lookup zamknąłem socket klienta.
Upstream mimo tego otrzymał później **jedno żądanie inferencji**.

**Poprawka:** rejestrować obsługę rozłączenia przed pierwszym asynchronicznym
oczekiwaniem, uwzględniać już zamknięte połączenie i sprawdzać anulowanie przed
zajęciem lease oraz uruchomieniem inferencji. Potrzebny test rozłączenia podczas
lookup, oprócz rozłączenia w trakcie streamu.

## 4. [P2] Prefiks folderu nie gwarantuje unikalności identyfikatorów modeli

**Miejsce:** `src/generation/local-api.ts:83–92`.

Przy kolizji nazwy pliku prefiks zawiera tylko nazwę bezpośredniego folderu.
Dwa różne katalogi mogą mieć taką samą ostatnią nazwę. `byId` wtedy bez ostrzeżenia
pomija drugi model. Nie można go wybrać przez API, a publiczny identyfikator
wskazuje wyłącznie pierwszy z plików.

**Potwierdzenie:** dwa syntetyczne GGUF-y w
`models/vendor-a/shared/twin.gguf` i `models/vendor-b/shared/twin.gguf`.
`listLocalApiModels()` zwróciło tylko **jeden** wpis: `shared/twin`.
Oba pliki spełniają zasady discovery; tracony jest wpis podczas tworzenia
publicznego katalogu.

**Poprawka:** po kwalifikacji ponownie wykrywać kolizje i rozszerzać prefiks lub
dodawać stabilny, nieujawniający ścieżki suffix. Każdy odkryty plik powinien mieć
unikalny identyfikator. Potrzebny test identycznych nazw bezpośrednich folderów
w różnych poddrzewach lub rootach.

## 5. [P2] UI nie pozwala wyłączyć API ani zmienić klucza podczas generacji

**Miejsce:** `client/src/components/GenerationSettings.tsx:196–204`;
powiązane: `src/routes/generation.ts:130–131`.

Formularz zawsze wysyła całą sekcję `llamaCpp`, także przy zmianie wyłącznie
`localApi`. Backend uzależnia zajęcie blokady od obecności tej sekcji, a nie od
rzeczywistej zmiany parametrów runtime. Podczas aktywnej generacji zapis z UI
zwraca więc 409. Użytkownik nie może wtedy wyłączyć dostępu sieciowego/API ani
ustawić lub zmienić klucza, nawet jeżeli ustawienia modelu pozostają bez zmian.
W szczególności nie może użyć wyłączenia listenera do zakończenia jego aktywnych
połączeń.

**Potwierdzenie:** przy wstrzymanej syntetycznej odpowiedzi inferencji zapis
`{ llamaCpp: { idleUnloadMinutes: 0 }, localApi: { enabled: false } }` zwrócił
**409**. Ten sam zapis bez sekcji `llamaCpp` zwrócił **200**. UI zawsze wysyła
wariant zawierający tę sekcję. Obecne testy wyłączania API wysyłają tylko
`localApi`, więc nie odtwarzają tego problemu.

**Poprawka:** wysyłać z formularza tylko zmienione sekcje albo po stronie serwera
zajmować blokadę wyłącznie dla zmian wymagających restartu runtime. Potrzebny test
zapisu ustawień dostępu z UI podczas aktywnej generacji.

## Walidacja i zakres

- `npm run check` — **PASS**: repo hygiene, ESLint, TypeScript, unit tests,
  API/MCP E2E, build klienta i Playwright.
- Unit tests: **494 passed, 2 skipped**, łącznie 496.
- API/MCP E2E: **16 passed**. Playwright: **71 passed**.
- Dodatkowe reprodukcje potwierdziły wszystkie pięć ustaleń. Używały danych
  syntetycznych, izolowanych katalogów tymczasowych oraz atrap runtime/upstreamu.
  Tymczasowe skrypty reprodukcyjne usunięto po review.
- Obecny upstream llama.cpp rejestruje przekazywane ścieżki inferencji, w tym
  Responses i Anthropic Messages/count_tokens:
  [kod rejestracji endpointów](https://github.com/ggml-org/llama.cpp/blob/master/tools/server/server.cpp).
  Testy z atrapą potwierdzają relay, ale nie dowodzą zgodności odpowiedzi
  rzeczywistego llama.cpp z każdym SDK; takiego testu nie wykonywałem.

Pierwotny review nie wprowadzał poprawek w kodzie aplikacji. Późniejsze poprawki
i testy opisano w sekcji „Status po poprawkach”.
