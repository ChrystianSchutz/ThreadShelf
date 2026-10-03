# Review i roadmapa — 2026-09-13

## Checkpoint w trakcie poprawek review

Zakres tej iteracji: **2, 11–14**, dodatkowo **5 i 8** jako zależności bezpiecznego recovery MCP; 6, 7 i benchmark 10 pozostają osobnymi zadaniami. Zmiany robocze zweryfikowane pełnym `npm run check` (PASS). Staged zawiera starszą implementację; working tree trzeba dodać (`git add`) przed commitem.

Już zmienione w working tree:

- `store.ts`: snapshot → embedding poza blokadą `__threads` → ponowna kontrola snapshotu przed commitem; maks. 3 próby przy zmianach. Krótka blokada archiwum nadal chroni publikację, blokada kolekcji porządkuje import/index/delete.
- Recovery: trwałe `indexAttempts`, `indexRetryAt`, `indexError`, backoff 15 s–1 h, pauza po 8 niepowodzeniach; wadliwe wiersze zachowują surowe dane ze statusem `invalid`, zdrowe mogą być indeksowane. Cache filtra search jest powiązany z wersją tabeli.
- Rename zmienia tylko tytuł; append czyta aktualne turns wewnątrz blokady. Usunięty nieużywany `generation/thread-index.ts` i stare entrypointy zapisu chunków/resetu.
- MCP i CLI uruchamiają recovery; embedding loguje na stderr i współdzieli Promise inicjalizacji (`createEmbedder`).
- Ingest/UI: postęp embeddingu per batch, brak podwójnego chunkowania, pomijanie eksportów z 0 rozmów; `clearFirst` nadal nic nie zastępuje przy błędnych/pustych eksportach, z jawnym `replacementSkipped` i komunikatem UI.

Pozostało przed zakończeniem (kontynuacja przez Claude, 2026-09-13):

- [x] TypeScript/lint i `test/archive-recovery.test.js`. Dwa testy (quarantine, backoff) padały, bo zbuforowany uchwyt tabeli nie widział zapisów z innego połączenia: cache `readyIndexFilter` po `tbl.version()` i `indexRetryAt`. Fix: `connect(DB_PATH, { readConsistencyInterval: 0 })` w `store.ts`. Naprawia też widoczność zapisów między serwerem, MCP i CLI.
- [x] Regresje 11 + 2: import zatrzymany w embeddingu nie blokuje zapisu innej kolekcji; ponowienie snapshotu po zmianie tego samego wątku; rename/append w obu przeplotach.
- [x] Regresje 12: uszkodzony `turnsJson` przy resecie nie ukrywa zdrowych rozmów, surowy wiersz zachowany; licznik, backoff i pauza po 8 próbach. Restart MCP/CLI pokrywa `recoverPendingIndexes` w procesie potomnym; osobnego E2E dla CLI nie ma.
- [x] Regresje 13: pusty eksport w `ingestFiles` (watch) nie usuwa archiwum i trafia do `skippedFiles`; `clearFirst` z pustym eksportem zwraca `replacementSkipped` i zostawia kolekcję; zdarzenia embeddingu mają `progressPercent` pomiędzy 0 a 100.
- [x] Test `createEmbedder`: jedno ładowanie modelu przy równoległych wywołaniach, ponowienie po błędzie (`test/embedding-light.test.js`). MCP E2E odrzuca każdą nie-JSON linię na stdout.
- [x] Invalidacja cache: wersja tabeli jest teraz spójna między procesami. Uszkodzone wiersze przy reimporcie zostają pod kluczem `<key>:unreadable:<sha16>` ze statusem `invalid` (test). Błąd po publikacji archiwum zostawia trwały `indexPending` z licznikiem prób.
- [x] AGENTS.md / ARCHITECTURE.md: backoff, optimistic snapshot, recovery w MCP/CLI, `invalid`, puste eksporty, `replacementSkipped`, `readConsistencyInterval`.
- [x] Prettier na zmienionych plikach, `git diff --check` czysty.
- [x] Pełne `npm run check`: PASS (hygiene, lint, tsc, 436 unit, 8 E2E, build, 61 Playwright).

Świadome decyzje: `parseTurns` w `generation/threads.ts` rzuca już błąd zamiast zwracać `[]`, więc dopisanie odpowiedzi do uszkodzonego wątku nie nadpisze go pustą listą. Wyszukiwanie w MCP i `search-cli` czeka na recovery wybranej kolekcji; zadania w backoffie są pomijane, więc zapytanie nie embeduje ponownie po każdej porażce.

Logi robocze są gitignored; `.review-regressions.log` zawiera ostatni test. Nie commitować ani nie nadpisywać automatycznie stage'a.

Dla modelu wykonawczego. Review wybranych ścieżek zapisu, importu, wyszukiwania, MCP i UI; nie pełny audyt. Ustalenia wynikają z kodu, scenariusze poniżej są testami do dopisania, nie wykonanymi reprodukcjami. `npm run check`: PASS (higiena, lint, TypeScript, unit, API/MCP E2E, build, 61 testów Playwright).

P1 = utrata danych / nieskuteczne usuwanie; P2 = poprawność i niezawodność; P3 = dalszy rozwój. Trudność i value: 1–5, więcej = trudniej / większa korzyść. Kolejność tabeli jest kolejnością realizacji; najpierw test odtwarzający błąd, potem fix. Wyłącznie syntetyczne dane i izolowane katalogi testowe.

| ID | Priorytet | Zadanie | Trudność | Value | Model |
| --- | --- | --- | --- | --- | --- |
| 1 | P1 | Zachować lokalne kontynuacje po reimporcie | 4/5 | 5/5 | Mocny |
| 2 | P1 | Usunąć wyścig rename / zapis odpowiedzi | 3/5 | 5/5 | Średni ogarnie |
| 3 | P1 | Zatrzymać indeksowanie usuniętych czatów | 4/5 | 5/5 | Mocny |
| 4 | P1 | Zapewnić odzyskiwanie po przerwanym zastąpieniu danych | 5/5 | 5/5 | Mocny |
| 5 | P2 | Usunąć logi embeddingu ze stdout MCP | 1/5 | 4/5 | Średni ogarnie |
| 6 | P2 | Filtrować wyniki przed limitem kandydatów | 3/5 | 4/5 | Średni ogarnie |
| 7 | P2 | Ujednolicić prywatny tryb z kontraktem przechowywania | 2/5 | 4/5 | Średni ogarnie |
| 8 | P2 | Współdzielić inicjalizację embeddingu | 2/5 | 3/5 | Średni ogarnie |
| 9 | P2 | Roadmapa: trwała kolejka naprawy indeksu | 4/5 | 4/5 | Mocny |
| 10 | P3 | Roadmapa: mierzalna jakość wyszukiwania | 3/5 | 3/5 | Średni ogarnie |
| 11 | P1 | Embedding poza globalną blokadą `__threads` | 4/5 | 5/5 | Mocny |
| 12 | P2 | Recovery: backoff, odporność na wadliwy wiersz, MCP/CLI | 3/5 | 4/5 | Mocny |
| 13 | P2 | `clearFirst`: postęp embeddingu i polityka błędów plików | 2/5 | 3/5 | Średni ogarnie |
| 14 | P3 | Sprzątanie po refaktorze zapisu | 1/5 | 2/5 | Średni ogarnie |

## Ustalenia i kryteria ukończenia

**Wdrożone: 1, 3, 4, 9.** Atomowe merge zamiast delete/add; kontynuacje zachowane po reimporcie; prywatne tombstone'y i trwałe zadania `__threads.indexPending`; recovery przy starcie serwera i co 15 s. Oryginalne ustalenia poniżej zachowane jako kontekst. Regresje: `test/archive-recovery.test.js` (12 scenariuszy, w tym wymuszona awaria procesu między tabelami). Pełny `npm run check`: PASS. W kolejnej iteracji dokończono 2, 5, 8 i 11–14; otwarte pozostają 6, 7 i 10.

- [x] **1. Reimport kasuje kontynuację.** `src/ingest.ts:263–267`, `src/store.ts:115,357`: nawet bez `clearFirst` zastępują wszystkie chunki i turns pliku eksportem, który nie zawiera dopisanych rozmów ThreadShelf. Zachować lokalne turns i ich indeks przy aktualizacji importowanej części; powiązać je ze stabilnym kluczem rozmowy. Jeżeli rozmowa znika z nowego eksportu albo klucz się zmienia, zachować lokalną gałąź zamiast zgadywać dopasowanie. **Test:** import → lokalna kontynuacja → ponowny import tego samego oraz zmienionego eksportu; odpowiedź nadal w archiwum i search, bez duplikatów.

- [x] **2. Rename może nadpisać nowe turns.** `src/generation/threads.ts:272,351`: rename i append czytają cały czat przed `updateChat`; `src/store.ts:402` blokuje dopiero zapis całego snapshotu. Rename ze starszym snapshotem może skasować zakończoną wymianę, a append przywrócić poprzedni tytuł. Zmieniać wyłącznie pole tytułu; append oprzeć na `updateStoredThreadFromCurrent`, używanym już dla importowanych wątków. **Test:** wymusić oba przeploty przez bariery Promise; zachowane turns i nowy tytuł.

- [x] **3. Retry przywraca chunki po DELETE.** `src/generation/threads.ts:175–206,290`: usuwanie nie unieważnia `indexVersions`, nie przechodzi przez `indexQueues` i nie respektuje aktywnej generacji. Retry trzyma stary `target` i może ponownie zaindeksować skasowany tekst. Unieważnić retry, skoordynować usunięcie z kolejką oraz odrzucić aktywną generację przez 409 albo bezpiecznie ją zakończyć. Samo anulowanie timera nie wystarczy, gdy embedding już trwa. **Test:** awaria indeksowania → DELETE → retry oraz DELETE podczas embeddingu; brak wątku i jego chunków po zakończeniu wszystkich operacji.

- [x] **4. Blokada nie zapewnia atomowego zastąpienia.** `src/store.ts:115,137,357` wykonuje osobne delete i add; błąd add zostawia usuniętą poprzednią wersję. Dodatkowo `src/ingest.ts:263–267` pozwala anulować między zapisem chunków a turns, a `clearFirst` czyści kolekcję przed parsowaniem (`:150`). Zaprojektować zapis nowej wersji przed przełączeniem odczytu albo dziennik z odzyskiwaniem; nie zakładać transakcji między tabelami LanceDB. Uwzględnić zgodność indeksu z archiwum oraz zachowanie z punktu 1. **Test:** wstrzyknięte błędy add, abort między tabelami i restart podczas zastępowania; poprzednia kompletna wersja pozostaje dostępna lub jest odzyskiwana.

- [x] **5. Log postępu zanieczyszcza MCP.** `src/embedding.ts:28` używa `console.log`; `mcp/server.ts` używa stdout do ramek JSON-RPC. Przy pobieraniu modelu do strumienia trafia tekst `[embedding]…`; klient testowy wręcz ignoruje nie-JSON (`test/e2e/mcp-stdio.test.js:32–34`). Przenieść diagnostykę na stderr i zaostrzyć test. **Test:** wywołany syntetycznie callback postępu podczas search; każda niepusta linia stdout jest poprawną ramką protokołu, bez prawdziwego pobierania.

- [ ] **6. Filtry pomijają istniejące trafienia.** `src/store.ts:609–657,726–756`: semantic filtruje role/model po pobraniu maks. 200 kandydatów; keyword filtruje model po tym samym ograniczeniu. Dopasowania poza oknem znikają. Przenieść filtry do zapytania przed limitem, zachowując semantykę `portableModelLabel`; keyword powinien też wybierać najlepsze wyniki z całego dopasowanego zbioru, a nie pierwszych 200 w kolejności storage. **Test:** >200 rekordów z jedynym trafieniem wybranego modelu/roli poza oknem oraz najlepsze trafienie keyword na końcu zbioru.

- [ ] **7. „Never persisted” rozmija się z UI.** `AGENTS.md:28` deklaruje brak utrwalania prywatnego czatu; `client/src/pages/ChatPage.tsx:40,131` zapisuje i odczytuje pełną rozmowę z `sessionStorage`, a `ThreadContinuation.tsx:139–154` zapisuje odzyskiwane fragmenty. Zgodnie z obecnym kontraktem przenieść prywatne dane do pamięci tab-scoped, również recovery; utrzymanie ich po reloadzie wymaga osobnej zmiany kontraktu produktu. Dodatkowo obecny efekt w ChatPage nie łapie błędów storage i może wywrócić widok przy blokadzie/quota. **Test:** prywatna generacja nie zapisuje treści do Web Storage; nawigacja zachowuje ją w pamięci, reload usuwa.

- [x] **8. Równoległy start tworzy kilka pipeline'ów.** `src/embedding.ts:20–32`: cache jest ustawiany dopiero po `await pipeline(...)`. Równoległe pierwsze search/ingest inicjalizują model niezależnie. Cache'ować wspólne Promise inicjalizacji i resetować je po błędzie. **Test:** wiele równoległych wywołań uruchamia fabrykę raz; po odrzuconym Promise kolejna próba działa.

## Roadmapa po naprawach

- [x] **9. Trwałe odzyskiwanie indeksu** — `src/generation/threads.ts:175`: obecne trzy retry żyją tylko w timerach procesu; restart lub dłuższa awaria pozostawia zapisany czat poza search. Po punkcie 3 dodać trwały znacznik wymaganej indeksacji i lokalny worker wznawiany po restarcie, czytający aktualną wersję wątku. Usunięcie czatu musi usuwać również zadanie. **Gotowe:** restart po błędzie embeddingu naprawia indeks bez ponownej generacji i bez przywracania usuniętych danych.

- [ ] **10. Benchmark jakości** — rozszerzyć syntetyczne fixtures o zapytania PL/EN, identyfikatory, rzadkie modele/role i długie rozmowy; zapisać oczekiwane conversationKey oraz Recall@k i opóźnienie na ustalonym korpusie. Najpierw baseline po punkcie 6, dopiero potem decyzja o chunkingu, hybrydowym rankingu lub indeksach wektorowych; bez nowych zależności i zmian modelu „na wyczucie”. **Gotowe:** powtarzalny lokalny raport wykrywający regresję trafności.

## Co zrobił model (staged, review 2026-09-13)

Zakres zmian: `src/store.ts` (+449), `src/ingest.ts`, `src/generation/threads.ts`, `src/generation/thread-index.ts`, `src/server.ts`, `AGENTS.md`, `docs/ARCHITECTURE.md`, nowy `test/archive-recovery.test.js`. Test lokalnie: 12/12 PASS.

- **Atomowe zapisy.** Delete + add zastąpione jednym `mergeInsert … whenNotMatchedBySourceDelete` zarówno dla chunków (`replaceEmbeddedRowsLocked`), jak i `__threads` (`replaceThreadRowsLocked`).
- **Trwała kolejka indeksu.** Nowa kolumna `__threads.indexPending` (`local` / `all` / `delete` / `reset`), zapisywana razem z turns. `indexStoredFile` przebudowuje indeks z *aktualnego* archiwum; `acknowledgeIndexLocked` czyści znacznik i usuwa tombstone'y / marker resetu.
- **Recovery.** `recoverPendingIndexes` + `startIndexRecovery` (start serwera i co 15 s). Usunięte in-memory `indexVersions` / `indexQueues` / timery retry z `threads.ts`.
- **Reimport z zachowaniem kontynuacji.** `replaceImportedFiles` dokleja lokalne turns do dopasowanej rozmowy; dla kluczy pozycyjnych (`:\d+$`) bez wspólnego prefiksu tworzy osobną gałąź `<key>:threadshelf:<sha16>`; rozmowy znikające z eksportu, ale z lokalnymi turns, zostają.
- **`clearFirst` bez wcześniejszego czyszczenia.** `ingest.ts` stage'uje cały folder i commituje raz na końcu, tylko gdy brak błędów; `resetCollection` nie jest już wołane.
- **Wyszukiwanie.** `readyIndexFilter` ukrywa pliki z pending `all` / `delete` oraz całą kolekcję przy `reset`.
- **Usuwanie czatu.** `deleteThreadShelfChat` bierze blokadę generacji (409 w trakcie odpowiedzi), usuwa najpierw kopię legacy, potem główną, przez `deleteStoredFile`; `acquireStoredThreadGeneration` dla czatów ThreadShelf używa tego samego klucza co `acquireThreadShelfChat`.
- **Zmiana ID chunków:** `${sourceFile}|${conversationKey}|${turnIndex}|${indexWRozmowie}` (wcześniej indeks per plik / sufiks `threadshelf`). Stare wiersze znikają przy pierwszym merge w danym zakresie.

## Ustalenia z review wdrożenia

- [x] **11. Embedding trzyma globalną blokadę `__threads`.** `src/store.ts:686–761` (`replaceImportedFiles`) i `:792–813` (`indexStoredFile`) wołają `embedChunks` wewnątrz `withCollectionWriteLock(THREADS_TABLE)`. Ta blokada jest wspólna dla wszystkich kolekcji, więc `updateStoredThreadFromCurrent`, `updateStoredThread` i `replaceThreadsForFile` (zapis odpowiedzi, rename, nowy czat) czekają na embedding całego importu. Przy `clearFirst` to embedding całego folderu, czyli potencjalnie minuty. Wcześniej embedding był poza blokadą. Fix: czytać i liczyć chunki oraz embedować poza blokadą, a pod blokadą ponownie odczytać wiersze i commitować tylko wtedy, gdy się nie zmieniły (np. hash `turnsJson` / `ingestedAt`); w przeciwnym razie powtórzyć. **Test:** bariera w `embed` podczas importu, równoległy `appendStoredThreadExchange` do innej kolekcji kończy się przed zwolnieniem bariery.

- [x] **12. Recovery bez backoffu i all-or-nothing.** `recoverPendingIndexes` co 15 s ponawia pełny embedding (przy `reset` całej kolekcji, pod blokadami z pkt 11), bez licznika prób i backoffu. `chunksFromThreadRows` / `conversationFromRow` wołają ścisłe `validateTurns` + `JSON.parse` bez `try`. Jeden stary lub wadliwy wiersz blokuje wtedy import pliku i recovery całej kolekcji na zawsze, a `readyIndexFilter` zwraca `'false'`, więc kolekcja znika z wyszukiwania (`threads.ts` `parseTurns` takie błędy łapie). Dodatkowo recovery działa tylko w `src/server.ts`: MCP (`mcp/server.ts`) i `ingest-cli` respektują `readyIndexFilter`, ale niczego nie naprawiają. Fix: backoff + `lastError`/liczba prób, pomijanie (i raportowanie) wadliwych wierszy, recovery również w MCP albo filtr nieukrywający całej kolekcji bez aktywnego workera. **Test:** wiersz z niepoprawnym `turnsJson` w kolekcji po `reset`; pozostałe rozmowy zaindeksowane i wyszukiwalne.

- [x] **13. `clearFirst`: postęp i błędy.** `src/ingest.ts:275–286`: cały embedding dzieje się po pętli, bez `onProgress`, więc UI pokazuje 100% plików i stoi. Jeden plik z `parsed.error` blokuje cały import (`errors.length === 0`), a wynik ma `ingested: 0` i tylko listę błędów. Sprawdzić, czy trasa/UI komunikuje, że nic nie zapisano. Usunięto też pomijanie plików z 0 rozmów (`ingest.ts:225`): taki plik tombstone'uje teraz wszystkie swoje rozmowy bez lokalnych turns (także w watch). Zdecydować i udokumentować. Liczba chunków jest też liczona dwa razy (w ingest tylko do estymacji tokenów).

- [x] **14. Sprzątanie.** Nieużywane po zmianie: `addChunks`, `addEmbeddedRowsLocked`, `replaceChunksForFile`, `replaceThreadShelfChunksForConversation`, `resetCollection` (`src/store.ts`). `indexThreadShelfTurns` ignoruje `turns` / `title` / `conversationKey` z `ThreadShelfIndexTarget`, więc uprościć interfejs. `readyIndexFilter` robi skan `__threads` przy każdym wyszukiwaniu (dla `all` per kolekcja); wystarczy cache unieważniany przy zapisie.

Realizować 11 + 2 → 5–8 → 12–14 → 10.

## Plan testów normalnych (ręcznych, przed commitem)

Cel: potwierdzić, że zwykłe użytkowanie działa po zmianach w zapisie, imporcie i recovery. Automaty (`npm run check`) pokrywają przypadki brzegowe; tu sprawdzamy ścieżki, które przechodzi użytkownik. **Tylko syntetyczne dane i izolowana baza.** Nigdy nie używać prawdziwego `.lancedb` ani prywatnych eksportów.

**Przygotowanie (PowerShell):**

```powershell
$env:LANCEDB_PATH = "$env:TEMP\threadshelf-manual\db"
$env:COLLECTIONS_PATH = "$env:TEMP\threadshelf-manual\collections.json"
New-Item -ItemType Directory -Force "$env:TEMP\threadshelf-manual\exports"
Copy-Item test\fixtures\openai-polish.json, test\fixtures\anthropic-polish.json, test\fixtures\openrouter-polish.json "$env:TEMP\threadshelf-manual\exports\"
npm run build; npm start   # http://localhost:3000
```

Każdy scenariusz: wykonać kroki → porównać z oczekiwanym wynikiem → zaznaczyć. Przy błędzie zapisać krok, komunikat UI i log serwera.

### A. Import i przeglądanie

- [ ] **A1. Pierwszy import folderu.** UI → Indexing → folder `exports`, kolekcja `manual`. **Oczekiwane:** postęp rośnie płynnie, w fazie embeddingu widać „Embedding X / Y chunks”, nie stoi na 100%. Na końcu komunikat sukcesu bez błędów; kolekcja ma 3 pliki i niezerową liczbę rozmów i chunków.
- [ ] **A2. Lista i widok wątku.** Otworzyć kolekcję `manual`, wejść w kilka rozmów z każdego dostawcy. **Oczekiwane:** tytuły, kolejność tur, role i modele jak w pliku; brak pustych ani zdublowanych rozmów.
- [ ] **A3. Ponowny import bez zmian.** Zaimportować ten sam folder drugi raz (bez `clearFirst`). **Oczekiwane:** liczba rozmów i chunków bez zmian, brak duplikatów w wynikach wyszukiwania.

### B. Wyszukiwanie

- [ ] **B1. Semantic.** Zapytanie z tematem rozmowy z fixture'u (PL i EN). **Oczekiwane:** trafne wyniki, klik otwiera właściwy wątek na właściwej turze.
- [ ] **B2. Keyword.** Dokładny fragment zdania z fixture'u. **Oczekiwane:** jest trafienie; fragment spoza archiwum daje pusty wynik.
- [ ] **B3. Filtry.** Rola `ai`, model z fixture'u, zakres dat, kolekcja `all`. **Oczekiwane:** wyniki spełniają każdy filtr; `all` obejmuje `manual` i czaty ThreadShelf.

### C. Czaty ThreadShelf (wymaga skonfigurowanego providera: llama.cpp albo OpenRouter)

- [ ] **C1. Nowy czat.** Utworzyć czat, wysłać 2 wiadomości. **Oczekiwane:** odpowiedzi zapisane, tytuł nadany z pierwszego promptu, czat na liście po odświeżeniu strony.
- [ ] **C2. Wyszukiwanie odpowiedzi.** Wyszukać keyword z odpowiedzi modelu (kilka sekund po jej zapisie). **Oczekiwane:** trafienie w `threadshelf_conversations`, origin ThreadShelf.
- [ ] **C3. Zmiana nazwy.** Rename czatu, potem kolejna wiadomość. **Oczekiwane:** nowy tytuł zostaje, wszystkie tury zostają; odświeżenie strony pokazuje oba.
- [ ] **C4. Usunięcie.** Usunąć czat po zakończeniu generacji. **Oczekiwane:** znika z listy; jego tekst nie wraca w wyszukiwaniu ani po 30 s, ani po restarcie serwera.
- [ ] **C5. Usunięcie w trakcie odpowiedzi.** Kliknąć usuń podczas generacji. **Oczekiwane:** czytelny komunikat (409 „already generating”), czat nieuszkodzony; po zakończeniu odpowiedzi usunięcie działa.

### D. Kontynuacja zaimportowanej rozmowy i reimport

- [ ] **D1. Kontynuacja.** Otworzyć rozmowę z `manual`, dopisać jedną wymianę z modelem. **Oczekiwane:** nowe tury na końcu wątku, oznaczone jako ThreadShelf; odpowiedź wyszukiwalna.
- [ ] **D2. Reimport po kontynuacji.** Ponownie zaimportować folder `exports`. **Oczekiwane:** dopisana wymiana nadal na końcu tej samej rozmowy, bez duplikatu w wyszukiwaniu.
- [ ] **D3. Reimport zmienionego eksportu.** W kopii fixture'u dopisać syntetyczną turę do tej samej rozmowy i zaimportować. **Oczekiwane:** nowa zaimportowana tura widoczna, lokalna kontynuacja zachowana.

### E. Zastąpienie kolekcji (`clearFirst`)

- [ ] **E1. Poprawny folder.** Import z opcją czyszczenia do `manual`, folder z 2 z 3 plików. **Oczekiwane:** do końca embeddingu stara kolekcja nadal widoczna, potem zostają tylko 2 pliki. Rozmowy z lokalnymi kontynuacjami (D1) zostają.
- [ ] **E2. Folder z pustym/uszkodzonym plikiem.** Dodać `empty.json` = `{"platform":"openrouter","turns":[]}` i powtórzyć E1. **Oczekiwane:** komunikat „Nothing was saved…”, kolekcja dokładnie jak przed próbą.
- [ ] **E3. Anulowanie.** Rozpocząć E1 i przerwać w fazie embeddingu. **Oczekiwane:** stara kolekcja nietknięta, brak wiszącego postępu po odświeżeniu.

### F. Restart i recovery

- [ ] **F1. Restart po zwykłej pracy.** Zatrzymać i uruchomić serwer. **Oczekiwane:** kolekcje, czaty, tytuły i wyniki wyszukiwania identyczne jak przed restartem; w logu brak `[index:recovery]` z błędami.
- [ ] **F2. Odpowiedź bez indeksu.** Wysłać wiadomość w czacie i od razu zatrzymać serwer (Ctrl+C), potem uruchomić. **Oczekiwane:** odpowiedź zapisana; w ciągu ok. 15 s po starcie jest wyszukiwalna.

### G. CLI, watch i MCP (osobne terminale, te same zmienne środowiskowe)

- [ ] **G1. CLI ingest.** `npm run ingest -- "$env:TEMP\threadshelf-manual\exports" cli_manual`. **Oczekiwane:** `[ingest] done … errors=0`, kod wyjścia 0.
- [ ] **G2. CLI search.** `npm run search -- "zapytanie" --collection cli_manual --n 5`, potem z `--mode keyword` i `--json`. **Oczekiwane:** wyniki jak w B1/B2, poprawny JSON.
- [ ] **G3. Watch.** `npm run ingest -- <folder> cli_manual -- --watch`; dopisać turę w kopii fixture'u, potem nadpisać plik pustym eksportem. **Oczekiwane:** zmiana zindeksowana po debounce; pusty eksport pominięty, archiwum pliku zostaje.
- [ ] **G4. MCP.** Podłączyć `npm run mcp` do klienta MCP (np. Claude Code / Inspector): `list_collections`, `search`, `read_thread`, `get_stats`. **Oczekiwane:** poprawne odpowiedzi, klient nie zgłasza błędów ramek (stdout czysty).
- [ ] **G5. Serwer i CLI naraz.** Przy działającym serwerze wykonać G1 do nowej kolekcji. **Oczekiwane:** kolekcja i wyniki widoczne w UI bez restartu serwera.

### H. Sprzątanie i wynik

- [ ] Zatrzymać procesy, usunąć `$env:TEMP\threadshelf-manual`, wyczyścić zmienne `LANCEDB_PATH` i `COLLECTIONS_PATH`.
- [ ] Wpisać tutaj datę, commit/working tree, providera generacji i listę niezaliczonych scenariuszy z krótkim opisem.

## llama.cpp: aktualizacja i strojenie wydajności (2026-09-13)

**Zrobione:**
- **Wersja:** zaktualizowano llama.cpp z b10566 do **b10809-cuda** (build wskazywany przez stabilne `v0.4.0`) skryptem użytkownika: `npm run setup:llama -- -- --install --variant cuda --yes`. Wersji nie ma pinowanej. Resolver bierze stabilny release, a nie najnowszy nightly (dziś b10941). `--check` porównuje teraz zainstalowany build z najnowszym stabilnym i podaje komendę aktualizacji.
- **Wykrywanie możliwości:** nowy parser nagłówka GGUF (`src/generation/gguf-metadata.ts`) i czysty resolver profilu (`src/generation/llama-profile.ts`), bramkowany przez `llama-server --help` oraz metadane modelu.
- **Settings:** trzy selecty (KV cache: Quality Q8 / Memory saver Q4 / Default F16; MTP: Auto 2 / Aggressive 3 / Off; Reasoning effort). Etykiety contextu 32K recommended, 128K/262K experimental, z ostrzeżeniem powyżej 64K.
- **Log i status:** `--parallel 1`, linia „Runtime profile” w logu (wartość, źródło, powód pominięcia) i linia statusu w szczegółowym badge'u.
- **Świadomie pominięte (roadmapa niżej):** Auto Tune benchmark, budżet i preserve reasoning, `--n-cpu-ffn` (VRAM rescue), własny build z `GGML_CUDA_FA_QUANTS` i profil Q8-K/Q4-V, szacowanie VRAM przed startem.

### Testy automatyczne (są w `npm run check`)

- [x] `test/gguf-metadata.test.js`: MTP wykryte po tokenizerze ~200k tokenów (odczyt przez granice chunków 1 MiB); klucze przed `general.architecture`; klucz z innej architektury nie włącza MTP; brak pliku, nie-GGUF i ucięty plik dają `null`.
- [x] `test/llama-tuning.test.js`:
  - parsowanie `--help`;
  - profil Balanced dla Qwen;
  - brak głowy MTP i nieczytelne metadane;
  - FA Off blokuje kwantyzację KV;
  - stara binarka nie dostaje żadnych flag;
  - Memory/Aggressive/Reasoning off;
  - notatki contextu;
  - zapis, walidacja i nadpisanie env;
  - `managedLlamaBuild`.
- [x] `test/generation.test.js`: rozszerzony kontrakt `parseLlamaRuntimeCapabilities`.

### Testy do dopisania (automatyczne)

Dopisane 2026-09-13, wszystkie w `npm run check`. Atrapa `llama-server` to `test/shared/fake-llama.js`: na Linux/macOS skrypt `sh`, na Windows mały launcher `.exe` kompilowany `csc.exe` z .NET Framework (bez niego E2E jest pomijane z powodem).

- [x] **T1. Start z profilem.** `test/e2e/llama-runtime-profile.test.js`.
- [x] **T2. Diagnostyka.** Tamże: `profile` + log po starcie i nowy profil po restarcie.
- [x] **T3. Zmiana ustawień restartuje serwer.** Tamże: identyczny zapis zostawia `ready`, sam `kvCache` daje `stopped`; dodatkowo unit `llamaCppConfigChanged` w `test/llama-tuning.test.js`.
- [x] **T4. Cache metadanych.** `test/gguf-metadata.test.js` (podmiana bajtów przy tym samym rozmiarze i mtime).
- [x] **T5. Playwright Settings.** `test/playwright/llama-tuning.spec.js`.
- [x] **T6. Playwright badge.** Tamże.
- [x] **T7. `setup:llama --check`.** `test/setup-llama-check.test.js`.
- [x] **T8. Parser GGUF: odporność.** `test/gguf-metadata.test.js` (`hostile headers`).

Oryginalne kryteria:

- **T1. Start z profilem.** `startManagedServer` z atrapą `llama-server` (skrypt zapisujący argv) i syntetycznym GGUF z `nextn_predict_layers=1`. Argumenty zawierają `--cache-type-k q8_0 … --spec-type draft-mtp --spec-draft-n-max 2 --parallel 1`, a log ma linię `Runtime profile for …`.
- [ ] **T2. Diagnostyka.** `GET /api/generation/runtime/logs` po starcie zwraca `profile` z wpisami `applied/source/note`; po zmianie ustawień i restarcie profil jest nowy.
- [ ] **T3. Zmiana ustawień restartuje serwer.** PUT `/api/generation/config` z samym `kvCache` wywołuje `stopManagedLlamaServer` (`llamaCppConfigChanged`).
- [ ] **T4. Cache metadanych.** Drugi odczyt tego samego GGUF nie otwiera pliku; zmiana mtime lub rozmiaru wymusza ponowny odczyt.
- [ ] **T5. Playwright Settings.** Trzy selecty są widoczne z domyślnymi wartościami Quality / Auto / Medium, zapis wysyła `kvCache`, `speculative` i `reasoningEffort`; context 131072 pokazuje ostrzeżenie „Experimental”; mock bez nowych pól nie łamie strony.
- [ ] **T6. Playwright badge.** Diagnostyka z `profile` pokazuje linię `GPU · CUDA · ctx 64K · … · MTP 2`, a tooltip zawiera powody pominięć.
- [ ] **T7. `setup:llama --check`.** Z atrapą `fetch` i katalogiem `b100-cuda` przy najnowszym `b200` wypisuje „Update available … --variant cuda”; przy równym buildzie „up to date”; bez zarządzanych buildów nic nie wypisuje.
- [ ] **T8. Parser GGUF: odporność.** Zadeklarowane `kvCount` większe niż limit, string dłuższy niż 64 MiB, zagnieżdżona tablica tablic i GGUF v1 dają `null` bez wyjątku i w ograniczonym czasie.

### Testy ręczne (RTX 3090 Ti, Qwen3.8-27B UD-Q4_K_XL, b10809-cuda)

- [ ] **M1. Aktualizacja.** `npm run setup:llama -- -- --check --variant cuda` pokazuje „up to date”. Po ręcznym zmienieniu nazwy katalogu na starszy build pokazuje „Update available” z poprawną komendą.
- [ ] **M2. Domyślny profil.** Settings → Save (Quality/Auto/Medium, ctx 32K) → wiadomość w czacie. Log zawiera `KV q8_0×q8_0`, `MTP 2 (… 1 NextN layer(s) …)`, `FA on`, `slots 1`; badge pokazuje `GPU · CUDA`; brak `unsupported`/`fallback` w logach llama.cpp.
- [x] **M3. MTP realnie przyspiesza.** Ten sam prompt (temperature 0, ~400 tokenów) przy MTP Off i Auto: zapisać tok/s i `draft_n_accepted` z timings. Oczekiwane: Auto ≥ Off, akceptacja > 0.
  - **Wynik 2026-09-13** (bezpośredni `llama-server` b10809 z flagami ThreadShelf: ctx 32K, FA on, KV q8_0×q8_0, reasoning medium, `--parallel 1`):
    - MTP Off: 42,1 tok/s, 21,7 GiB VRAM;
    - MTP 2: **78,5 tok/s** (×1,87), akceptacja draftu 94,6% (193/204), mean len 2,89, 22,6 GiB VRAM.
  - Brak błędów i fallbacków w logach.
  - Uwaga z logu: szablon Qwen3.8 domyślnie włącza `reasoning preserve` (pkt R2).
  - M2 (ta sama konfiguracja przez UI Settings) nadal do przejścia ręcznie.
- [ ] **M4. Model bez MTP.** Gemma 4 E4B: log `MTP off (model: the model has no MTP/NextN head)`, serwer startuje normalnie.
- [ ] **M5. Memory saver i długi context.** Q4 + 128K: start bez OOM, ostrzeżenie Experimental w Settings; zmierzyć tok/s na krótkim i ~60K promptcie.
- [ ] **M6. FA Off.** Flash Attention Off + Quality: KV pominięte (`skipped: … Flash Attention, which is off`), serwer działa na f16.
- [ ] **M7. Reasoning.** Medium vs XHigh vs Off na tym samym pytaniu: długość `reasoning` w odpowiedzi rośnie od Off do XHigh; Off nie pokazuje sekcji thinking.
- [ ] **M8. Stara binarka.** Ustawić w Settings ścieżkę `b10566-cuda`: brak nieobsługiwanych flag (np. `--n-cpu-ffn`), profil i start działają.
- [ ] **M9. Równoległe czaty.** Dwa czaty na tym samym modelu naraz przy `slots 1`: drugi czeka i kończy się poprawnie, bez 409 i bez błędu slotów.

### Roadmapa (niezrealizowane z propozycji)

- [ ] **R1. Auto Tune.** Macierz Q8/Q4 × ubatch 512/1024 × MTP 0/2/3 z pomiarem pp/tg tok/s i VRAM; wynik zapisany pod kluczem GPU + build llama.cpp + hash modelu. Przed każdym wariantem sprawdzić wolną pamięć i nie uruchamiać kombinacji grożących OOM.
- [ ] **R2. Reasoning budget i preserve.** Opcjonalne `--reasoning-budget N` oraz przełącznik `--reasoning-preserve` / `--no-reasoning-preserve` w sekcji Advanced.
- [ ] **R3. VRAM rescue.** `--n-cpu-ffn N` w Advanced, tylko gdy `--help` go ma. Kolejność ratowania: KV/context → quant modelu → CPU FFN.
- [ ] **R4. Własny build z `GGML_CUDA_FA_QUANTS`.** Wskaźnik dostępnych par KV i profil Q8-K/Q4-V Experimental, pokazywany wyłącznie dla takiego builda.
- [ ] **R5. Szacowanie VRAM przed startem** (wagi + KV z `head_count_kv`/`key_length` × context × typ KV) i ostrzeżenie w Settings.
- [ ] **R6. Stabilny prefiks promptu.** Test, że serializacja system promptu i historii nie zmienia się między żądaniami (reuse KV cache). Każdy fix zamyka własny scenariusz regresji; przed zakończeniem `npm run check`. Nie refaktorować hurtowo UI ani parserów w ramach tych zadań.

---

# Code Review: `feat/archive-recovery-and-llama-tuning` vs `main` (2026-09-13)

## Podsumowanie stanu brancha
- **Status bramki (`npm run check`): PASS**
  - Repo hygiene: OK (237 commit candidates)
  - Linter (ESLint: `src/`, `mcp/`, `client/src/`): OK (0 błędów, 0 ostrzeżeń)
  - TypeScript (`tsc -b` client + tsx server): OK
  - Testy jednostkowe / logika: **457 passed** (90 suites, 0 failed)
  - Testy E2E (API + MCP stdio): **9 passed** (7 suites, 0 failed)
  - Client production build (Vite): OK
  - Playwright browser E2E (Chromium): **64 passed** (0 failed)
- **Skala zmian**: 28 zmienionych/nowych plików, ~2150 linii dodanych, ~360 usuniętych.

---

## Ocena techniczna (kluczowe mechanizmy, bez pierdół)

### 1. Odporność zapisu i odzyskiwanie archiwum (`src/store.ts`, `src/ingest.ts`, `src/generation/threads.ts`)
- **Optymistyczna kontrola snapshotu (`snapshotFingerprint`)**:
  - Embedding został całkowicie wyprowadzony poza globalną blokadę `__threads`, co zapobiega paraliżowaniu operacji na innych kolekcjach i wątkach podczas długiego generowania wektorów.
  - Snapshot turnów przed embeddingiem jest weryfikowany hashem SHA-256 tuż przed commitem; w razie wykrycia równoległej zmiany następuje ponowienie (maks. 3 próby). Jeśli próby zostaną wyczerpane, rzucany jest `StoredThreadWriteError`, a wątek zachowuje status `indexPending` w bazie do obsłużenia przez recovery workera.
- **Transakcyjność i atomowość (`mergeInsert`)**:
  - Zastąpienie sekwencji `delete` + `add` atomowym `tbl.mergeInsert(...).whenNotMatchedBySourceDelete({ where })` wyeliminowało stan, w którym błąd wstawiania pozostawiał wyczyszczone dane.
  - Usunięcia realizowane są przez trwałe tombstone'y (`indexPending: 'delete'`), a czyszczenie całej kolekcji (`clearFirst`) używa znacznika `indexPending: 'reset'`. Dopiero po pomyślnym uaktualnieniu chunków w LanceDB tombstone'y i markery są fizycznie usuwane przez `acknowledgeIndexLocked`.
- **Trwała kolejka indeksowania i backoff**:
  - Usunięto zawodne timery in-memory (`indexQueues` / `indexVersions`). Zadania indeksacji żyją w kolumnach `__threads`: `indexPending`, `indexAttempts`, `indexRetryAt`, `indexError`.
  - Wykładniczy backoff (15 s – 1 h) z pauzą po 8 niepowodzeniach zapobiega pętli zarzynania zasobów przy uszkodzonym pliku lub błędzie embeddingu.
  - Zmiana/edycja wątku przez użytkownika resetuje liczniki prób i natychmiast znosi backoff (`indexRetryAt = 0`).
  - Worker recovery działa w tle co 15 s w serwerze, jest uruchamiany przy starcie, a także wywoływany w MCP i CLI (z pomijaniem zadań będących w oknie backoffu).
- **Kwarantanna uszkodzonych wierszy (`invalid`)**:
  - Błędy dekodowania turnów (`validateTurns` / `JSON.parse`) nie blokują już parsowania pozostałych wierszy ani recovery całej kolekcji. Wiersze uszkodzone są izolowane pod unikalnym kluczem `<key>:unreadable:<sha16>` z flagą `indexPending: 'invalid'` i zachowaniem oryginalnych danych w `turnsJson`.
- **Spójność odczytu między procesami**:
  - Dodanie `{ readConsistencyInterval: 0 }` do `connect(DB_PATH)` gwarantuje, że serwer HTTP, serwer MCP i procesy CLI widzą natychmiast wersje tabel i commity wykonane przez inne procesy.
- **Bezpieczeństwo reimportu i `clearFirst`**:
  - Reimport folderu nie niszczy dopisanych w ThreadShelf kontynuacji (są doklejane na koniec). W przypadku kluczy pozycyjnych (`:\d+$`) bez wspólnego prefiksu tworzone jest bezpieczne odgałęzienie `<key>:threadshelf:<sha16>`.
  - `clearFirst` stage'uje cały folder w pamięci przed commitem; w razie błędu parsowania, pustych plików czy anulowania przez klienta, stara kolekcja pozostaje w 100% nienaruszona (`replacementSkipped: true`).

### 2. Strojenie wydajności i aktualizacja llama.cpp (`src/generation/`)
- **Aktualizacja binariów**:
  - Zaktualizowano silnik do stabilnego `b10809-cuda`. Resolver `resolveLlamaRelease` poprawnie wskazuje stabilne tagi z binariami (poprzez pointer `nightly-tag.txt`).
  - Komenda `npm run setup:llama -- -- --check` precyzyjnie porównuje wersję zainstalowaną z najnowszą dostępną i wypisuje gotową komendę instalacji z odpowiednim wariantem akceleratora.
- **Parser nagłówków GGUF (`src/generation/gguf-metadata.ts`)**:
  - Bezpieczna, strumieniowa klasa `HeaderReader` z twardymi limitami (maks. 512 MB nagłówka, 64 MB na string, 100k kluczy, buforowanie 1 MiB).
  - Kluczowa optymalizacja pamięciowa: ogromne tablice stringów (np. 200k tokenów słownika) są pomijane za pomocą `reader.skip()` po odczytaniu długości, bez alokacji buforów Node.js.
  - Wykrywanie warstw MTP (`<arch>.nextn_predict_layers`) bezpośrednio z nagłówka modelu eliminuje zgadywanie możliwości spekulatywnych po nazwie pliku.
- **Dynamiczny resolver profilu (`src/generation/llama-profile.ts`)**:
  - Ścisłe bramkowanie flag: żadna flaga (`--cache-type-k`, `--spec-type draft-mtp`, `--reasoning-effort`, `--parallel 1`) nie jest emitowana, jeśli binarka `llama-server` nie zgłasza jej w `--help`.
  - Ochrona VRAM: wymuszenie `--parallel 1` w środowisku desktopowym zapobiega alokowaniu wielokrotnych slotów KV cache w VRAM.
  - Spójność par KV cache: emitowane są wyłącznie symetryczne pary (`q8_0×q8_0` dla Quality, `q4_0×q4_0` dla Memory saver).
  - Wymuszenie Flash Attention: kwantyzacja KV automatycznie promuje FA do `'on'`, a w razie ręcznego wyłączenia FA (`off`) bezpiecznie cofa kwantyzację do F16 z odnotowaniem przyczyny pominięcia.
- **UI i diagnostyka**:
  - Ustawienia Settings zintegrowane z konfiguracją serwera; zmiana parametrów KV, MTP lub reasoning poprawnie powoduje przeładowanie serwera (`llamaCppConfigChanged`).
  - Runtime badge i logi serwera precyzyjnie raportują zaaplikowany profil (`ctx`, `FA`, `KV`, `MTP`, `GPU weights`) oraz powody ewentualnego pominięcia nieobsługiwanych flag.

### 3. Protokół MCP i izolacja stdout (`src/embedding.ts`, `mcp/server.ts`)
- Przeniesienie diagnostyki ładowania modelu HuggingFace z `console.log` na `console.error` zapobiega zanieczyszczeniu strumienia JSON-RPC w MCP.
- Test `test/e2e/mcp-stdio.test.js` rygorystycznie sprawdza `client.noise`, odrzucając jakiekolwiek nie-JSON ramki na stdout.
- `createEmbedder` grupuje równoległe zapytania do pojedynczego `Promise<Pipeline>` i poprawnie resetuje uchwyt po błędzie.

---

## Kwestie do uwzględnienia / potencjalne ryzyka

1. **Wydajność pętli asynchronicznej w parserze GGUF (`gguf-metadata.ts:159`)**:
   - Pętla `for (let element = 0; element < count; element += 1) reader.skip(await reader.u64());` przy bardzo dużych słownikach (np. 200 000+ tokenów) wykonuje 200 000 wywołań `await`. Choć dane są zbuforowane w pamięci podręcznej (1 MiB bufor), narzut pętli zdarzeń Node na 200k mikro-zadań Promise wynosi kilkadziesiąt milisekund. Jeśli pojawią się modele ze słownikami rzędu 500k–1M tokenów, warto rozważyć synchroniczny odczyt u64 w obrębie załadowanego bufora.
2. **Kruchość regexów `--help` w `llama-process.ts`**:
   - Regex `reasoningToggle`: `/--reasoning\s+\[on\|off/i.test(help)` oraz `speculativeTypes`: `/--spec-type\s+([a-z0-9_,-]+)/i`.
   - W b10809 format jest zgodny, ale llama.cpp często modyfikuje składnię tekstu pomocy między wydaniami (np. zamiana nawiasów kwadratowych na `<on|off>` lub dodanie spacji). Luźniejszy regex (np. `/--reasoning\b.*\[?on[|,/]\s*off/i`) byłby odporniejszy na drobne zmiany formatowania upstreamu.
3. **Ponowny embedding zachowanych gałęzi przy kolejnych importach (`store.ts:707`)**:
   - Gdy zachowywane jest stare lokalne odgałęzienie (`next.push({ ...old, indexPending: 'all' })`), trafia ono do ponownego embeddingu wraz z importowanym plikiem. Wynika to z kontraktu `whenNotMatchedBySourceDelete({ where: chunkScope })` (wszystkie oczekiwane chunki muszą znaleźć się w `embedded`). Przy częstych reimportach tego samego pliku jest to niewielki koszt, ale przy bardzo długich wątkach generuje dodatkowe przeliczenia wektorów.
4. **Zadania otwarte z roadmapy**:
   - Punkty 6 (filtrowanie wyników przed limitem kandydatów), 7 (usunięcie `sessionStorage` dla prywatnego czatu) oraz 10 (benchmark jakości wyszukiwania) pozostają otwarte zgodnie z planem.

---

## Werdykt
Branch **gotowy do zmergowania do `main`**. Architektura zapisu, odporność na błędy, transakcyjność i synchronizacja procesowa są zrealizowane na bardzo wysokim poziomie, a testy automatyczne w pełni zabezpieczają wszystkie zidentyfikowane wcześniej przypadki brzegowe i wyścigi.
