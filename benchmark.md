# Lokalny benchmark modeli GGUF — 28.09.2026, uzupełniony 02.10.2026

## Sprzęt i zakres

- GPU: NVIDIA GeForce RTX 3090 Ti, 24 GiB VRAM; sterownik 591.86. CPU: AMD Ryzen 7 8700F (8C/16T), RAM: 96 GiB.
- Runtime: `llama.cpp` b10809 CUDA (`llama-bench` i `llama-server`), Windows, jeden model i jeden slot naraz. Modele i prompty pozostawały lokalnie.
- Qwen: `huihui-ai/Huihui-Qwen3.8-27B-abliterated-GGUF`, plik `Huihui-Qwen3.8-27B-abliterated-UD-Q4_K_XL.gguf` (16,19 GiB). GGUF: 65 bloków (w tym warstwa MTP/NextN), kontekst 262 144.
- Gemma: `lmstudio-community/gemma-4-26B-A4B-it-GGUF`, plik `gemma-4-26B-A4B-it-Q4_K_M.gguf` (15,64 GiB). GGUF: 30 warstw, kontekst 262 144. **Ten konkretny model jest wariantem IT, nie abliterated.** Lokalnie znalezione warianty Gemma 4 bez cenzury/abliterated to E4B i 31B, nie 26B-A4B; nie należy utożsamiać ich wyników.
- Qwen (normalny, **nie** abliterated, dodany 02.10): `unsloth/Qwen3.8-27B-GGUF`, plik `Qwen3.8-27B-UD-Q4_K_M.gguf` (15,33 GiB). Ta sama architektura co wersja Huihui (65 bloków z MTP/NextN, kontekst 262 144), ale **inna kwantyzacja**: UD-Q4_K_M zamiast UD-Q4_K_XL, o 0,86 GiB mniejsza.
- Qwen3-Coder (dodany 02.10): `unsloth/Qwen3-Coder-30B-A3B-Instruct-GGUF`, plik `Qwen3-Coder-30B-A3B-Instruct-Q4_K_M.gguf` (17,28 GiB, SHA-256 zgodny z repozytorium). MoE: 128 ekspertów, 8 aktywnych, około 3,3 mld aktywnych parametrów; 48 warstw, kontekst 262 144, bez MTP. Wybrany, bo to najczęściej pobierany GGUF na Hugging Face.
- Bielik (dodany 02.10): `speakleash/Bielik-11B-v3.0-Instruct-GGUF`, plik `Bielik-11B-v3.0-Instruct.Q8_0.gguf` (11,05 GiB). Gęsty 11B (architektura llama, 50 warstw), **kontekst natywny tylko 32 768**, bez MTP. Polski model SpeakLeash.
- Usunięty 02.10, aby zwolnić miejsce: `0bserverx/Qwen3.8-27B-Heretic-Abliterated-Uncensored-GGUF` (`RVN-Q4_K_M-multilingual.gguf`, 15,4 GiB). Nie był mierzony.
- Muse: oficjalny `meta-models/Muse-Glimmer-30B-GGUF`, plik `Muse-Glimmer-30B-KQuant-17GB-Q4_K_M.gguf` (15,61 GiB). GGUF: 52 warstwy, kontekst 131 072. Model i dodatkowy `dflash-Muse-Glimmer-30B-Q4_K_M.gguf` (1,52 GiB) pobrano i zweryfikowano względem SHA-256 z repozytorium. Drafter jest w `.threadshelf/bench-assets/`, aby nie pojawiał się w wyborze modeli rozmowy.

Natywny limit z nagłówka GGUF jest granicą modelu, a nie obietnicą wygodnej pracy przy tej długości. [Qwen deklaruje 262 144 tokeny natywnie](https://huggingface.co/Qwen/Qwen3.8-27B), [Gemma 4 26B-A4B ma kontekst 256K](https://huggingface.co/google/gemma-4-26B-A4B), a [oficjalny GGUF Muse podaje 131 072+](https://huggingface.co/meta-models/Muse-Glimmer-30B-GGUF). Rozszerzania RoPE ani nadpisywania metadanych nie testowałem.

## Metoda

`llama-bench`: pełny offload GPU (`-ngl 99`), Flash Attention włączone, batch 2048, ubatch 512, 8 wątków. Krótki test: 512 i 2048 tokenów wejścia oraz 128 tokenów generowania, 2 powtórzenia; symetryczny cache KV Q8. Długi test: `-d` wypełnia cache do podanej głębokości, potem mierzy 512/2048 tokenów wejścia i 64/128 wyjścia; cache KV Q4, po 1 powtórzeniu. `pp` to przetwarzanie wejścia, `tg` to generowanie; oba w tok./s. Wyniki długiego testu opisują szybkość **po wypełnieniu** kontekstu. Samo wypełnienie może trwać od kilkunastu sekund do kilku minut. Nie jest to test trafności przywoływania informacji z początku kontekstu.

Pomiary z 02.10 (normalny Qwen, Qwen3-Coder, Bielik) używają tych samych komend, tej samej wersji llama.cpp i tych samych promptów. Wyniki są w `.threadshelf/bench-qwenstd-*`, `bench-coder-*` i `bench-bielik-*` (UTF-8). Qwen3-Coder mierzyłem z `-mmp 0` / `--no-mmap`; na szybkość GPU to nie wpływa, ale plik modelu nie zostaje w RAM-ie. Bielik ma natywnie tylko 32k, więc u niego „długi kontekst” to 8k/16k/30k, a porównanie Q8/Q4 jest przy 30k zamiast 32k.

Serwerowy test speculative decoding: `/completion`, jeden slot, kontekst 8192, 256 wygenerowanych tokenów, `temperature=0`, `ignore_eos=true`, symetryczny cache KV Q8. Dwa prompty: lista zastosowań notatnika oraz kod Python z trzema algorytmami sortowania/wyszukiwania. Wartości pochodzą z pola `timings.predicted_per_second`; uruchomienie modelu nie wchodzi do tego pomiaru. Surowe lokalne wyniki są w ignorowanych plikach `.threadshelf/bench-*.jsonl` i `.threadshelf/bench-server-*.log`.

## Szybkość przy krótkim kontekście

| Model                           | `pp 512` | `pp 2048` | `tg 128` | KV  |
| ------------------------------- | -------: | --------: | -------: | --- |
| Qwen3.8-27B abliterated Q4_K_XL |     1475 |      1525 |     42,2 | Q8  |
| Qwen3.8-27B normalny UD-Q4_K_M  |     1563 |      1568 |     44,5 | Q8  |
| Gemma 4 26B-A4B IT Q4_K_M       |     4917 |      4877 |    142,7 | Q8  |
| Qwen3-Coder 30B-A3B Q4_K_M      |     4217 |      4330 |    185,8 | Q8  |
| Muse Glimmer 30B Q4_K_M         |     1778 |      1756 |     44,8 | Q8  |
| Bielik 11B v3.0 Q8_0            |     3846 |      3740 |     64,4 | Q8  |

Gemma 4 26B-A4B jest modelem MoE z około 3,8 mld aktywnych parametrów na token, co pomaga wyjaśnić dużą przewagę prędkości generowania nad dwoma modelami gęstymi. [Karta modelu Google](https://huggingface.co/google/gemma-4-26B-A4B).

Przełączenie KV na Q4 przy krótkim kontekście prawie nie zmieniło prędkości: Qwen 42,6 zamiast 42,2 tok./s, Gemma 139,8 zamiast 142,7 tok./s, normalny Qwen 44,3 zamiast 44,5, Qwen3-Coder 177,8 zamiast 185,8, Bielik 64,4 i 64,4. Q4 oszczędza VRAM przy długim kontekście, ale może pogorszyć jakość.

Porównanie przy jednakowo wypełnionym cache 32k, wejściu 512 i wyjściu 64 (po jednym powtórzeniu):

| Model         | KV Q8: `pp` / `tg` | KV Q4: `pp` / `tg` | Wniosek                                    |
| ------------- | -----------------: | -----------------: | ------------------------------------------ |
| Qwen          |        1129 / 35,8 |        1124 / 35,4 | Różnica mała; Q8 na co dzień.              |
| Gemma         |       2981 / 100,5 |       3099 / 107,4 | Q4 szybsze o około 7% w generowaniu.       |
| Muse          |        1467 / 39,1 |        1463 / 37,2 | Różnica mała; Q8 na co dzień.              |
| Qwen normalny |        1166 / 38,0 |        1151 / 36,8 | Różnica mała; Q8 na co dzień.              |
| Qwen3-Coder   |        1603 / 62,6 |        1710 / 61,5 | Różnica mała.                              |
| Bielik (30k)  |        1631 / 40,2 |        1628 / 38,8 | Różnica mała; Q8, bo 32k i tak się mieści. |

Q8 pozostaje rozsądnym wyborem do zadań wymagających dokładności, jeśli kontekst mieści się w VRAM. Q4 wybierać przede wszystkim dla pojemności; w Gemmie daje także umiarkowany zysk szybkości.

## Długi kontekst — KV Q4, Flash Attention

| Model         | Głębokość cache | `pp` |  `tg` | Uwagi                                                                                                |
| ------------- | --------------: | ---: | ----: | ---------------------------------------------------------------------------------------------------- |
| Qwen          |              8k | 1409 |  40,7 | Wejście 2048, wyjście 128                                                                            |
| Qwen          |             32k | 1130 |  35,0 | Wejście 2048, wyjście 128                                                                            |
| Qwen          |             64k |  891 |  30,3 | Wejście 2048, wyjście 128; około 20 GiB VRAM                                                         |
| Qwen          |            128k |  626 |  23,4 | Wejście 512, wyjście 64; około 21,3 GiB VRAM                                                         |
| Qwen          |            256k |  390 |  15,9 | Wejście 512, wyjście 64; około 24,1 GiB VRAM, prawie bez zapasu                                      |
| Gemma         |              8k | 4276 | 128,3 | Wejście 2048, wyjście 128                                                                            |
| Gemma         |             32k | 3186 | 109,5 | Wejście 2048, wyjście 128                                                                            |
| Gemma         |             64k | 2310 |  89,8 | Wejście 512, wyjście 64                                                                              |
| Gemma         |            128k | 1501 |  68,5 | Wejście 512, wyjście 64                                                                              |
| Gemma         |            256k |  886 |  45,8 | Wejście 512, wyjście 64; około 21,5 GiB VRAM                                                         |
| Muse          |             32k | 1463 |  37,2 | Wejście 512, wyjście 64                                                                              |
| Muse          |             64k | 1271 |  34,6 | Wejście 512, wyjście 64                                                                              |
| Muse          |            128k | 1011 |  28,8 | Wejście 512, wyjście 64                                                                              |
| Qwen normalny |              8k | 1428 |  42,5 | Wejście 2048, wyjście 128                                                                            |
| Qwen normalny |             32k | 1147 |  36,5 | Wejście 2048, wyjście 128                                                                            |
| Qwen normalny |             64k |  897 |  31,3 | Wejście 2048, wyjście 128                                                                            |
| Qwen normalny |            128k |  635 |  23,8 | Wejście 512, wyjście 64                                                                              |
| Qwen normalny |            256k |  396 |  16,4 | Wejście 512, wyjście 64                                                                              |
| Qwen3-Coder   |              8k | 3042 | 126,4 | Wejście 2048, wyjście 128                                                                            |
| Qwen3-Coder   |             32k | 1724 |  61,4 | Wejście 2048, wyjście 128                                                                            |
| Qwen3-Coder   |             64k | 1105 |  38,0 | Wejście 512, wyjście 64                                                                              |
| Qwen3-Coder   |            128k |  556 |  19,4 | Wejście 512, wyjście 64                                                                              |
| Qwen3-Coder   |            256k |    — |     — | **Nie mieści się w 24 GB.** VRAM 23,7/24 GiB, reszta poszła do RAM; po 16 min wypełniania przerwałem |
| Bielik        |              8k | 2732 |  54,5 | Wejście 512, wyjście 64                                                                              |
| Bielik        |             16k | 2230 |  47,8 | Wejście 512, wyjście 64                                                                              |
| Bielik        |             30k | 1628 |  38,8 | Wejście 512, wyjście 64; tuż pod natywnym limitem 32k                                                |

Qwen3-Coder jest najszybszy przy pustym kontekście, ale traci najszybciej: 186 → 61 tok./s przy 32k → 19 przy 128k. Przy 128k jest już wolniejszy od gęstego Qwena (23,8). Gemma trzyma tempo najlepiej (68,5 przy 128k).

Pomiary `-d` dowodzą, że benchmark uruchomił i wypełnił te głębokości z pełnym offloadem GPU. Osobno `llama-server` uruchomił i obsłużył krótkie żądanie przy `-c 262144` dla Qwena i Gemmy oraz `-c 131072` dla Muse, z `-ngl 99` i KV Q4; Muse wystartował także z DFlash 16. To potwierdza działanie konfiguracji serwera, lecz nie dowodzi dokładności przywoływania na całej długości.

## Speculative decoding na rzeczywistym serwerze

| Model/ustawienie        | Lista, tok./s | Kod, tok./s | Komentarz                            |
| ----------------------- | ------------: | ----------: | ------------------------------------ |
| Qwen bez MTP            |          42,0 |        42,0 | Punkt odniesienia                    |
| Qwen MTP, 2 tokeny      |      **65,5** |    **74,5** | Najlepszy z testowanych ustawień MTP |
| Qwen MTP, 3 tokeny      |          61,8 |           — | Na liście wolniej niż 2 tokeny       |
| Qwen normalny bez MTP   |          43,6 |        43,8 | Punkt odniesienia                    |
| Qwen normalny MTP 2     |      **71,6** |    **76,0** | Najlepszy; 148/213 i 154/201 szkiców |
| Qwen normalny MTP 3     |          71,2 |           — | Bez zysku względem 2                 |
| Qwen3-Coder bez szkicu  |         168,6 |       175,6 | Brak głowicy MTP                     |
| Bielik bez szkicu       |          63,1 |        63,6 | Brak MTP; prompt po polsku: 63,2     |
| Muse bez DFlash         |          44,1 |        44,1 | Punkt odniesienia                    |
| Muse DFlash, 3 tokeny   |          57,2 |           — | Domyślne `n-max` w llama.cpp         |
| Muse DFlash, 8 tokenów  |         106,2 |           — | Duży zysk                            |
| Muse DFlash, 16 tokenów |     **121,4** |   **178,5** | Najlepszy z testowanych bloków       |

Qwen przy MTP 2 zaakceptował 142/225 szkiców na liście i 156/197 w kodzie. Muse DFlash przy bloku 16 zaakceptował 208/692 szkiców na liście i 224/462 w kodzie. Różnice między promptami są duże, więc nie należy traktować jednej liczby jako stałej szybkości każdego zadania. Speculative decoding weryfikuje szkice modelem głównym; pomiary nie sprawdzają jakości odpowiedzi.

## Qwen abliterated vs normalny

Oba pliki to Qwen3.8-27B z głowicą MTP; różnią się abliteracją **i** kwantyzacją (Huihui UD-Q4_K_XL 16,19 GiB, unsloth UD-Q4_K_M 15,33 GiB). Te same komendy, ten sam sprzęt:

| Pomiar                          | Abliterated (Huihui) | Normalny (unsloth) | Różnica       |
| ------------------------------- | -------------------: | -----------------: | ------------- |
| `pp 512` / `pp 2048`            |          1475 / 1525 |        1563 / 1568 | +6% / +3%     |
| `tg 128`, pusty kontekst        |                 42,2 |               44,5 | +5%           |
| `tg` przy 32k, KV Q8            |                 35,8 |               38,0 | +6%           |
| `tg` przy 32k, KV Q4            |                 35,4 |               36,8 | +4%           |
| `tg` przy 64k / 128k / 256k Q4  |   30,3 / 23,4 / 15,9 | 31,3 / 23,8 / 16,4 | +2–3%         |
| Serwer bez MTP, lista / kod     |          42,0 / 42,0 |        43,6 / 43,8 | +4%           |
| Serwer MTP 2, lista / kod       |          65,5 / 74,5 |        71,6 / 76,0 | **+9%** / +2% |
| Akceptacja szkiców MTP 2, lista |        142/225 (63%) |      148/213 (69%) | +6 p.p.       |
| Akceptacja szkiców MTP 2, kod   |        156/197 (79%) |      154/201 (77%) | −2 p.p.       |
| Serwer MTP 3, lista             |                 61,8 |               71,2 | +15%          |

Wnioski:

- **Normalny jest o 3–6% szybszy, a to w większości efekt mniejszej kwantyzacji**, nie abliteracji. Abliteracja nie zmienia architektury ani liczby obliczeń na token.
- **Przy MTP różnica rośnie na swobodnym tekście** (lista: +9%, MTP 3: +15%). Moja hipoteza, której nie weryfikowałem: abliteracja modyfikuje wagi głównego modelu, a głowica MTP przewiduje pod model oryginalny, więc część szkiców przestaje pasować. Na kodzie, gdzie tekst jest przewidywalny, różnicy prawie nie ma.
- **Jakości nie mierzyłem.** Artificial Analysis ani inne niezależne rankingi nie oceniają wersji Huihui. Abliteracja usuwa odmowy, a często kosztuje trochę na benchmarkach; skala zależy od wykonania.

## Inteligencja vs szybkość

Inteligencja z [Artificial Analysis Intelligence Index](https://artificialanalysis.ai/models/open-source/small) (obecna wersja v4.3, 10 testów: agentowe, kod, wiedza, rozumowanie). AA mierzy modele w pełnej precyzji przez API; lokalny Q4 GGUF wypadnie zwykle trochę gorzej. Bielika AA nie ocenia, więc podaję polskie rankingi z [raportu Bielik 11B v3](https://arxiv.org/abs/2601.11579). Szybkość jest z tego benchmarku (RTX 3090 Ti).

| Model                   | Inteligencja (AA Index)                                     | Inne źródła                                                                                                                                                                                                   | `tg` pusty | `tg` przy 32k | Najszybszy tryb     | Max kontekst na 24 GB |
| ----------------------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------: | ------------: | ------------------- | --------------------- |
| Qwen3.8 27B (normalny)  | **34** (xhigh), 28 (medium), 26 (low), 20 (bez rozumowania) | Najwyższy wynik w klasie „small open source” (4–40B) na AA                                                                                                                                                    |       44,5 |          38,0 | MTP 2: 72–76        | 256k (16 tok./s)      |
| Qwen3.8 27B abliterated | brak niezależnej oceny                                      | ~ jak wyżej minus koszt abliteracji (nie mierzony)                                                                                                                                                            |       42,2 |          35,8 | MTP 2: 66–75        | 256k (16 tok./s)      |
| Gemma 4 26B-A4B         | 17 (z rozumowaniem)                                         | —                                                                                                                                                                                                             |      142,7 |         100,5 | bez szkicu: 143     | 256k (46 tok./s)      |
| Muse Glimmer 30B        | 17 (high)                                                   | Artykuł AA z premiery podawał 35, ale na starszej wersji indeksu; obecna lista: 17                                                                                                                            |       44,8 |          39,1 | DFlash 16: 121–178  | 128k (natywnie)       |
| Qwen3-Coder 30B-A3B     | 10                                                          | Model z 2025 r., bez rozumowania                                                                                                                                                                              |      185,8 |          62,6 | bez szkicu: 169–176 | 128k                  |
| Bielik 11B v3.0         | brak w AA                                                   | Open PL LLM Leaderboard **65,93** (5-shot): tuż za Llama-3.3-70B (66,40), przed Qwen3-32B (64,24) i gemma-3-27b (56,13). PLCC (kultura i język polski) 71,83%, 1. miejsce wśród modeli open source w raporcie |       64,4 |    40,2 (30k) | bez szkicu: 63      | 32k (limit modelu)    |

Jak to czytać: liczba AA dla Qwena „xhigh” wymaga długiego rozumowania. Przy 72 tok./s 3000 tokenów myślenia to ponad 40 s przed odpowiedzią. Wyniki „medium” (28) i „bez rozumowania” (20) lepiej oddają szybką pracę. Nawet bez rozumowania Qwen 3.8 (20) jest wyżej niż Gemma i Muse z rozumowaniem (17).

## Rekomendacje (moja opinia — Claude Opus)

To moja ocena na podstawie powyższych liczb, nie wynik pomiaru jakości na Twoich zadaniach.

1. **Domyślny model do agentów (Claude Code, Codex, DeepSeek Harness przez ThreadShelf): Qwen3.8 27B normalny.** Ma najwyższy wynik inteligencji w tej grupie, z dużym odstępem (34/28 wobec 17), z MTP 2 pisze 72–76 tok./s, a 256k mieści się w 24 GB. Ustawienia: 64k, KV Q4 (Memory saver), Speculative Auto, rozumowanie Medium. Przy 64k spodziewaj się około 31 tok./s, więc agent będzie myślał wolniej niż na Gemmie, ale mądrzej.
2. **Szybki czat, długie dokumenty, zrzuty ekranu: Gemma 4 26B-A4B.** Jest 3× szybsza, najlepiej trzyma tempo przy długim kontekście (69 tok./s przy 128k) i ma na dysku gotowy `mmproj` do vision. Za szybkość płacisz inteligencją: 17 wobec 28–34.
3. **Teksty po polsku, korespondencja, pytania o polskie realia: Bielik.** W polskich rankingach dorównuje modelom 70B, a przy 11 GB jest najlżejszy. Nie nadaje się do agentów, bo ma tylko 32k kontekstu.
4. **Qwen abliterated tylko wtedy, gdy naprawdę przeszkadzają Ci odmowy.** Normalny jest szybszy, ma lepszą akceptację MTP i niezależnie zmierzoną inteligencję. Jeśli odmowy nie przeszkadzają, abliterated można usunąć i odzyskać 16,2 GB.
5. **Qwen3-Coder: raczej nie.** Najszybszy przy krótkim kontekście (186 tok./s), ale ma najniższy wynik (10) i jest generacją starszy od Qwena 3.8. Przy 32k traci dwie trzecie prędkości, a 256k się nie mieści. Do krótkich poprawek „napisz funkcję” bywa wygodny; do agentów lepszy jest Qwen 3.8. Jeśli brakuje miejsca, to pierwszy kandydat do usunięcia (17,3 GB).
6. **Muse: tylko z DFlash.** Bez draftera ma tę samą inteligencję co Gemma (17) przy 3× mniejszej prędkości. Z własnym `llama-server` i DFlash 16 robi się z niego najszybszy model do generowania kodu (178 tok./s), ale ThreadShelf nie uruchamia DFlash sam.

Zestaw minimalny przy ciasnym dysku: Qwen 3.8 normalny + Gemma + Bielik (razem około 42 GB).

## Rekomendowane profile

| Cel                       | Ustawienia                                    | Oczekiwany kompromis                                                                                                                                           |
| ------------------------- | --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Qwen na co dzień          | 32k, pełny GPU, Flash Attention, KV Q8, MTP 2 | Około 35,8 tok./s bez MTP przy zapełnionych 32k; MTP znacznie przyspiesza krótkie generowanie.                                                                 |
| Qwen długie wątki         | 64k, KV Q4, MTP 2                             | Około 30 tok./s bez MTP przy 64k; przy 128k około 23 tok./s i dużo dłuższe wczytywanie. 256k działa w benchmarku, ale ma 15,9 tok./s i niemal wyczerpuje VRAM. |
| Gemma na co dzień         | 32k, pełny GPU, Flash Attention, KV Q8 lub Q4 | Najszybsza w tej trójce; przy 32k Q8 ma około 100,5, a Q4 około 107,4 tok./s w porównywalnym teście.                                                           |
| Gemma maksymalny kontekst | 256k, KV Q4, pełny GPU                        | Działa na 3090 Ti; około 45,8 tok./s po kosztownym wypełnieniu, mały zapas VRAM.                                                                               |
| Muse na co dzień          | 32k, Flash Attention, KV Q8, DFlash 16        | DFlash mocno przyspiesza krótkie generowanie; pomiar z DFlash wykonano przy kontekście 8k.                                                                     |
| Muse długie wątki         | Do 128k, KV Q4                                | Serwer startuje z DFlash 16 przy natywnym limicie; około 28,8 tok./s bez DFlash przy zapełnionych 128k. Prędkości DFlash przy zapełnionych 128k nie mierzono.  |

Obecna konfiguracja ThreadShelf (`contextSize=32768`, `kvCache=quality`, `flashAttention=auto`, `speculative=auto`) jest sensowną bazą dla Qwena i Gemmy. `speculative=auto` wybiera dla Qwena MTP 2, jeśli nagłówek GGUF i `llama-server --help` potwierdzają obsługę. ThreadShelf nie ma obecnie pola do podania osobnego modelu DFlash; wynik Muse 121–178 tok./s wymaga własnego `llama-server` na loopback z `--spec-draft-model ... --spec-draft-n-max 16`. Jego adres można wskazać jako lokalny `baseUrl`.

Przykładowe flagi dla Muse: `-ngl 99 -c 32768 -np 1 -fa on -ctk q8_0 -ctv q8_0 -md .threadshelf/bench-assets/dflash-Muse-Glimmer-30B-Q4_K_M.gguf -ngld 99 --spec-draft-n-max 16 --jinja --host 127.0.0.1`. Dla Qwena: `-ngl 99 -c 32768 -np 1 -fa on -ctk q8_0 -ctv q8_0 --spec-type draft-mtp --spec-draft-n-max 2`. Na 128k/256k użyć symetrycznego `q4_0` dla obu połówek KV. Nie mieszać typów K i V.

## Co te liczby oznaczają dla agenta?

Model pisze tokeny; agent dodatkowo otwiera pliki, uruchamia polecenia, czeka na przeglądarkę i testy, a po każdym kroku ponownie przetwarza historię. **Tok./s nie jest prędkością całego zadania.** Poniżej czas wyłącznie na wygenerowanie 1000 tokenów w krótkiej rozmowie, obliczony z testów serwera:

| Model i ustawienie    | Pisanie 1000 tokenów | Co zmierzono                        |
| --------------------- | -------------------: | ----------------------------------- |
| Gemma, bez spekulacji |            około 7 s | 143 tok./s przy krótkim kontekście  |
| Qwen, MTP 2           |        około 13–15 s | 65–75 tok./s, zależnie od promptu   |
| Muse, DFlash 16       |          około 6–8 s | 121–178 tok./s, zależnie od promptu |

Przykład: agent piszący program może wygenerować 2500 tokenów w kilku krokach. Samo ich napisanie, **gdy kontekst jest krótki**, zajmie orientacyjnie Gemmie 18 s, Qwenowi z MTP 33–38 s, Muse z DFlash 14–21 s. Do tego dochodzą wszystkie odczyty repozytorium, uruchomienia narzędzi, testy i ponowne przetwarzanie historii. Całe zadanie może więc potrwać minuty; nie mierzyłem kompletnego przebiegu agenta i nie podaję jednej obietnicy czasu.

Gdy historia urośnie do 32k, **bez speculative decoding** pomiar dał Gemmie 100,5 tok./s (około 10 s na 1000 tokenów), Qwenowi 35,8 (około 28 s), Muse 39,1 (około 26 s). Nie mierzyłem MTP/DFlash na zapełnionych 32k, więc szybkości z krótkiego kontekstu nie należy przenosić wprost na długi projekt. Długie wewnętrzne rozumowanie modelu także zużywa tokeny i czas, nawet gdy agent pokazuje tylko gotową odpowiedź.

Agent „wchodzący na stronę” potrzebuje narzędzia przeglądarkowego. Odczyt HTML/tekstu strony **nie wymaga vision**; oglądanie zrzutu ekranu już tak. Czas ładowania strony, skryptów i wywołań narzędzia dodaje się do czasu modelu. Żaden z powyższych pomiarów tok./s nie obejmował przeglądarki ani pisania kodu z uruchamianiem testów.

### Skąd tak duża różnica między modelami?

1. **Gemma 26B-A4B jest MoE:** ma około 26 mld parametrów ogółem, ale aktywuje około 3,8 mld na token. Qwen 27B i Muse 30B są modelami gęstymi, więc pojedynczy token wymaga więcej pracy GPU. To główne wyjaśnienie, dlaczego Gemma bez żadnego draftera osiąga 143 tok./s, a pozostałe około 42–45 tok./s. [Karta Gemmy](https://huggingface.co/google/gemma-4-26B-A4B), [karta Muse](https://huggingface.co/meta-models/Muse-Glimmer-30B-GGUF), [karta Qwena](https://huggingface.co/Qwen/Qwen3.8-27B).
2. **MTP i DFlash zgadują kilka tokenów naprzód, a główny model je sprawdza.** Przyjęte szkice przyspieszają generowanie. Zysk zależy od treści: dla Muse z DFlash 16 wyszło 121 tok./s na liście i 178 tok./s na kodzie. Nie powiększa to kontekstu ani nie sprawia, że model lepiej rozumuje.
3. **Dłuższa historia spowalnia każdy kolejny token.** Qwen bez MTP spadł z 42 tok./s na starcie do 35 przy 32k i 16 przy 256k; przy 256k prawie cała pamięć GPU była zajęta. Również ponowne wczytanie długiej historii kosztuje czas.

### Vision: co jest gotowe na tym komputerze?

Wszystkie trzy rodziny modeli obsługują obrazy. [Qwen](https://huggingface.co/Qwen/Qwen3.8-27B) i [Gemma](https://huggingface.co/google/gemma-4-26B-A4B-it-assistant) mają wejście obrazowe, a [Muse wymaga osobnego encodera `mmproj`](https://huggingface.co/meta-models/Muse-Glimmer-30B-GGUF). W przypadku tych lokalnych GGUF potrzebne są następujące pliki:

| Model | Główny GGUF | Projektor obrazu (`mmproj`)                                                                                                                | Gotowość lokalna                                   |
| ----- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------- |
| Qwen  | jest        | brak; [plik w repozytorium modelu](https://huggingface.co/huihui-ai/Huihui-Qwen3.8-27B-abliterated-GGUF/blob/main/mmproj-model-bf16.gguf)  | Tekst działa; obrazy wymagają pobrania projektora. |
| Gemma | jest        | jest: `mmproj-gemma-4-26B-A4B-it-BF16.gguf`                                                                                                | Pliki do vision są na dysku.                       |
| Muse  | jest        | brak; [plik w repozytorium modelu](https://huggingface.co/meta-models/Muse-Glimmer-30B-GGUF/blob/main/mmproj-Muse-Glimmer-30B-Q4_K_M.gguf) | Tekst działa; obrazy wymagają pobrania projektora. |

Wbudowany czat ThreadShelf obecnie wysyła wiadomości jako sam tekst (`ChatMessage.content: string`), więc nie prześle agentowi zrzutu ekranu. Do vision trzeba użyć klienta/agenta, który wysyła obrazy do `llama-server` uruchomionego z `--mmproj`. Dla Gemmy sprawdziłem rzeczywisty obraz: 682 tokeny wejścia przetworzyła w około 1 s, a 128 tokenów wyjścia wygenerowała z szybkością około 125 tok./s. To **pojedyncza próba**, a nie benchmark różnych obrazów. Przy domyślnym `ubatch=512` ta wersja llama-server zakończyła się błędem asercji; działająca komenda poniżej ustawia `-b 4096 -ub 4096`. Ustawia też `--reasoning off`, ponieważ przy limicie 512 tokenów rozumowanie zużyło całą odpowiedź bez widocznego tekstu.

#### Jak agent korzystałby z Playwright i vision

1. Agent wydaje Playwright polecenie otwarcia strony i odczytu tekstu/struktury DOM. Wiele zadań, np. znalezienie linku lub wypełnienie formularza, może oprzeć na tym bez obrazu.
2. Gdy trzeba ocenić wygląd, układ lub element niewidoczny w DOM, [Playwright robi zrzut](https://playwright.dev/docs/screenshots) przez `page.screenshot()`. Najlepiej zacząć od widocznego obszaru albo konkretnego elementu; pełna, długa strona daje większy obraz i dłuższe przetwarzanie.
3. Kod agenta zamienia bufor PNG na `data:image/png;base64,...` i wysyła go wraz z pytaniem jako `image_url` do lokalnego [`/v1/chat/completions`](https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md). `mmproj` koduje obraz, a model odpowiada tekstem. Następnie agent wybiera akcję Playwright, np. kliknięcie, robi kolejny zrzut i sprawdza efekt.

Sam Playwright steruje przeglądarką; **nie zapewnia pętli decyzyjnej agenta ani połączenia z vision**. Potrzebny jest klient, który udostępnia modelowi narzędzia Playwright i potrafi przekazać zrzut do API jako obraz. Obecny czat ThreadShelf tego nie robi. Poniżej jest mały przykład jednego przebiegu na Linuksie, który pokazuje samo połączenie; nie jest pełnym agentem. Przy zrzutach ekranu szybkość będzie zależeć od rozdzielczości, liczby obrazów i tego, ile kroków wykona przeglądarka. Jedna lokalna próba Gemmy trwała około 2 s dla 128 tokenów, lecz nie pozwala przewidzieć czasu całego zadania.

### Lokalne pliki modeli

Poniższe linki prowadzą do plików w **tym** checkoutcie. Łącznik do Gemmy jest lokalnym junction do katalogu LM Studio, bez kopiowania 15,64 GiB modelu; sam junction jest ignorowany przez Git.

| Plik            | Link                                                                                                                                                                |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Qwen            | [Huihui-Qwen3.8-27B-abliterated-UD-Q4_K_XL.gguf](.threadshelf/models/huihui-ai__Huihui-Qwen3.8-27B-abliterated-GGUF/Huihui-Qwen3.8-27B-abliterated-UD-Q4_K_XL.gguf) |
| Gemma           | [gemma-4-26B-A4B-it-Q4_K_M.gguf](.threadshelf/bench-links/gemma-4-26B-A4B-it-GGUF/gemma-4-26B-A4B-it-Q4_K_M.gguf)                                                   |
| Projektor Gemmy | [mmproj-gemma-4-26B-A4B-it-BF16.gguf](.threadshelf/bench-links/gemma-4-26B-A4B-it-GGUF/mmproj-gemma-4-26B-A4B-it-BF16.gguf)                                         |
| Muse            | [Muse-Glimmer-30B-KQuant-17GB-Q4_K_M.gguf](.threadshelf/models/meta-models__Muse-Glimmer-30B-GGUF/Muse-Glimmer-30B-KQuant-17GB-Q4_K_M.gguf)                         |
| DFlash Muse     | [dflash-Muse-Glimmer-30B-Q4_K_M.gguf](.threadshelf/bench-assets/dflash-Muse-Glimmer-30B-Q4_K_M.gguf)                                                                |
| Qwen normalny   | [Qwen3.8-27B-UD-Q4_K_M.gguf](.threadshelf/models/unsloth__Qwen3.8-27B-GGUF/Qwen3.8-27B-UD-Q4_K_M.gguf)                                                              |
| Qwen3-Coder     | [Qwen3-Coder-30B-A3B-Instruct-Q4_K_M.gguf](.threadshelf/models/unsloth__Qwen3-Coder-30B-A3B-Instruct-GGUF/Qwen3-Coder-30B-A3B-Instruct-Q4_K_M.gguf)                 |
| Bielik          | [Bielik-11B-v3.0-Instruct.Q8_0.gguf](.threadshelf/models/speakleash__Bielik-11B-v3.0-Instruct-GGUF/Bielik-11B-v3.0-Instruct.Q8_0.gguf)                              |

## Ograniczenia

- Wyniki zależą od konkretnej kwantyzacji, wersji llama.cpp, temperatury i taktowania GPU oraz rodzaju tekstu. Długie testy miały po jednym powtórzeniu; różnice kilku procent mogą być szumem.
- Testy szybkości nie oceniają jakości modeli ani poprawności pamięci przy długim kontekście. Q4 KV warto porównać z Q8 na własnych zadaniach wymagających dokładnego odczytu.
- Muse i Gemma mogą przyjmować obrazy z `mmproj`, ale tutaj mierzony był wyłącznie tekst. Qwen również był mierzony wyłącznie jako model tekstowy.
- **Uwaga do pomiarów z 02.10:** pierwszy przebieg Qwen3-Coder przez pomyłkę uruchomił dwa `llama-bench` naraz. Model wylał się wtedy do RAM-u (44 GB, 3 tok./s, zamulony komputer). Ten wynik odrzuciłem i powtórzyłem pomiary pojedynczym procesem. Wyniki normalnego Qwena i Bielika powstały wcześniej i nie były zakłócone.
- Oceny inteligencji pochodzą z zewnętrznych stron (stan na 02.10.2026) i dotyczą modeli w pełnej precyzji, nie tych plików Q4/Q8.
- **Limit mocy GPU sprawdzony 02.10:** `nvidia-smi` pokazuje limit 450 W (domyślny 450, maksymalny 480), więc karta nie jest przycięta do 300 W. Na normalnym Qwenie pobór sięgał 447 W przy czytaniu promptu, z flagą „SW power cap”, a przy generowaniu wynosił około 420–440 W. Średnio pod obciążeniem wyszło około 400 W. Odczyty około 300 W są normalne przy lżejszej pracy: modele MoE (Gemma, Qwen3-Coder), krótkie żądania, przerwy między krokami agenta. Generowanie tokenów ogranicza głównie przepustowość pamięci VRAM, nie moc, więc limit 300 W obniżyłby `tg` tylko o kilka procent; bardziej odczułoby to czytanie promptu (`pp`).
- `llama-bench` mierzy szybkość po wypełnieniu cache. Samo wypełnienie 256k zajęło około 170 s na Gemmie i 420 s na Qwenie; opóźnienie pierwszej odpowiedzi przy bardzo długim nowym promptcie będzie istotne. `-d 262144` plus tokeny następnego promptu/odpowiedzi może minimalnie przekroczyć natywny limit modelu; ten test potwierdza obciążenie sprzętu, a nie jakość odpowiedzi na granicy okna.

## Komendy do skopiowania — PowerShell

Uruchom PowerShell w katalogu głównym ThreadShelf. **Każdy blok działa osobno.** Serwer słucha tylko na `127.0.0.1:8080`; agentowi ustaw adres API `http://127.0.0.1:8080/v1`. Przed uruchomieniem następnego modelu zatrzymaj poprzedni serwer przez `Ctrl+C`.

### Qwen: kod i strony jako tekst, MTP 2

```powershell
$server = '.\.threadshelf\tools\llama.cpp\b10809-cuda\llama-server.exe'
$model = '.\.threadshelf\models\huihui-ai__Huihui-Qwen3.8-27B-abliterated-GGUF\Huihui-Qwen3.8-27B-abliterated-UD-Q4_K_XL.gguf'
& $server -m $model -c 32768 -np 1 -ngl 99 -fa on -ctk q8_0 -ctv q8_0 --spec-type draft-mtp --spec-draft-n-max 2 --jinja --host 127.0.0.1 --port 8080
```

### Qwen normalny (nie abliterated), MTP 2 — mój domyślny wybór do agentów

```powershell
$server = '.\.threadshelf\tools\llama.cpp\b10809-cuda\llama-server.exe'
$model = '.\.threadshelf\models\unsloth__Qwen3.8-27B-GGUF\Qwen3.8-27B-UD-Q4_K_M.gguf'
& $server -m $model -c 65536 -np 1 -ngl 99 -fa on -ctk q4_0 -ctv q4_0 --spec-type draft-mtp --spec-draft-n-max 2 --jinja --host 127.0.0.1 --port 8080
```

### Bielik: po polsku, 32k

```powershell
$server = '.\.threadshelf\tools\llama.cpp\b10809-cuda\llama-server.exe'
$model = '.\.threadshelf\models\speakleash__Bielik-11B-v3.0-Instruct-GGUF\Bielik-11B-v3.0-Instruct.Q8_0.gguf'
& $server -m $model -c 32768 -np 1 -ngl 99 -fa on -ctk q8_0 -ctv q8_0 --jinja --host 127.0.0.1 --port 8080
```

### Qwen3-Coder: krótkie zadania z kodem, do 128k

```powershell
$server = '.\.threadshelf\tools\llama.cpp\b10809-cuda\llama-server.exe'
$model = '.\.threadshelf\models\unsloth__Qwen3-Coder-30B-A3B-Instruct-GGUF\Qwen3-Coder-30B-A3B-Instruct-Q4_K_M.gguf'
& $server -m $model -c 32768 -np 1 -ngl 99 -fa on -ctk q8_0 -ctv q8_0 --jinja --host 127.0.0.1 --port 8080
```

### Gemma: kod i strony jako tekst

```powershell
$server = '.\.threadshelf\tools\llama.cpp\b10809-cuda\llama-server.exe'
$model = Join-Path $env:USERPROFILE '.lmstudio\models\lmstudio-community\gemma-4-26B-A4B-it-GGUF\gemma-4-26B-A4B-it-Q4_K_M.gguf'
& $server -m $model -c 32768 -np 1 -ngl 99 -fa on -ctk q8_0 -ctv q8_0 --jinja --host 127.0.0.1 --port 8080
```

### Gemma ze zrzutami ekranu (vision)

```powershell
$server = '.\.threadshelf\tools\llama.cpp\b10809-cuda\llama-server.exe'
$model = Join-Path $env:USERPROFILE '.lmstudio\models\lmstudio-community\gemma-4-26B-A4B-it-GGUF\gemma-4-26B-A4B-it-Q4_K_M.gguf'
$vision = Join-Path $env:USERPROFILE '.lmstudio\models\lmstudio-community\gemma-4-26B-A4B-it-GGUF\mmproj-gemma-4-26B-A4B-it-BF16.gguf'
& $server -m $model --mmproj $vision -c 32768 -np 1 -ngl 99 -fa on -ctk q8_0 -ctv q8_0 -b 4096 -ub 4096 --reasoning off --jinja --host 127.0.0.1 --port 8080
```

### Muse: kod i strony jako tekst, DFlash 16

```powershell
$server = '.\.threadshelf\tools\llama.cpp\b10809-cuda\llama-server.exe'
$model = '.\.threadshelf\models\meta-models__Muse-Glimmer-30B-GGUF\Muse-Glimmer-30B-KQuant-17GB-Q4_K_M.gguf'
$dflash = '.\.threadshelf\bench-assets\dflash-Muse-Glimmer-30B-Q4_K_M.gguf'
& $server -m $model -md $dflash -ngld 99 --spec-draft-n-max 16 -c 32768 -np 1 -ngl 99 -fa on -ctk q8_0 -ctv q8_0 --jinja --host 127.0.0.1 --port 8080
```

### Powtórzenie szybkiego benchmarku Gemmy

```powershell
$bench = '.\.threadshelf\tools\llama.cpp\b10809-cuda\llama-bench.exe'
$model = Join-Path $env:USERPROFILE '.lmstudio\models\lmstudio-community\gemma-4-26B-A4B-it-GGUF\gemma-4-26B-A4B-it-Q4_K_M.gguf'
& $bench -m $model -p 512,2048 -n 128 -r 2 -ngl 99 -fa on -ctk q8_0 -ctv q8_0
```

### Sprawdzenie, czy serwer działa i jaki model załadował

```powershell
Invoke-RestMethod http://127.0.0.1:8080/health
Invoke-RestMethod http://127.0.0.1:8080/v1/models
```

### Jedno pytanie tekstowe do uruchomionego serwera

```powershell
$body = @{ messages = @(@{ role = 'user'; content = 'Napisz krótki program Hello World w Pythonie.' }); max_tokens = 256; stream = $false } | ConvertTo-Json -Depth 10
(Invoke-RestMethod http://127.0.0.1:8080/v1/chat/completions -Method Post -ContentType 'application/json' -Body $body).choices[0].message.content
```

### Jeden obraz do Gemmy vision (najpierw uruchom jej serwer powyżej)

```powershell
$png = [Convert]::ToBase64String([IO.File]::ReadAllBytes((Resolve-Path 'docs/assets/conversation-generation.png')))
$body = @{ messages = @(@{ role = 'user'; content = @(@{ type = 'text'; text = 'Co widać na obrazku? Odpowiedz krótko.' }, @{ type = 'image_url'; image_url = @{ url = "data:image/png;base64,$png" } }) }); max_tokens = 256; stream = $false } | ConvertTo-Json -Depth 10
(Invoke-RestMethod http://127.0.0.1:8080/v1/chat/completions -Method Post -ContentType 'application/json' -Body $body).choices[0].message.content
```

## Komendy do skopiowania — Linux / WSL

To są odpowiedniki flag dla **linuksowego** `llama.cpp` z obsługą CUDA; pomiary powyżej wykonano na Windows, więc prędkość na Linuksie/WSL trzeba zmierzyć osobno. Windowsowy `llama-server.exe` z `.threadshelf/tools/` nie jest binarką Linuksa. Uruchom powłokę `bash` w katalogu ThreadShelf. Pliki Qwen/Muse muszą być dostępne pod pokazanymi ścieżkami, a Gemma pod ścieżką ustawioną w `GEMMA`. W WSL możesz wskazać plik Gemmy z Windows przez `/mnt/c/Users/username/.lmstudio/...`, podstawiając własną nazwę użytkownika. Każdy serwer działa na `127.0.0.1:8080`; zatrzymaj go przez `Ctrl+C`, zanim uruchomisz następny.

### 1. Ustaw ścieżki raz w terminalu

```bash
LLAMA_BIN="$HOME/llama.cpp/build/bin" # zmień, jeśli zbudowałeś llama.cpp gdzie indziej
QWEN="$PWD/.threadshelf/models/huihui-ai__Huihui-Qwen3.8-27B-abliterated-GGUF/Huihui-Qwen3.8-27B-abliterated-UD-Q4_K_XL.gguf"
MUSE="$PWD/.threadshelf/models/meta-models__Muse-Glimmer-30B-GGUF/Muse-Glimmer-30B-KQuant-17GB-Q4_K_M.gguf"
DFLASH="$PWD/.threadshelf/bench-assets/dflash-Muse-Glimmer-30B-Q4_K_M.gguf"
GEMMA="$HOME/.lmstudio/models/lmstudio-community/gemma-4-26B-A4B-it-GGUF/gemma-4-26B-A4B-it-Q4_K_M.gguf"
GEMMA_MMPROJ="$HOME/.lmstudio/models/lmstudio-community/gemma-4-26B-A4B-it-GGUF/mmproj-gemma-4-26B-A4B-it-BF16.gguf"
ls -lh "$LLAMA_BIN/llama-server" "$QWEN" "$GEMMA" "$GEMMA_MMPROJ" "$MUSE" "$DFLASH"
```

Jeśli `ls` zgłosi brak pliku, popraw tę jedną ścieżkę przed dalszymi komendami. Na tej maszynie Gemma leży w katalogu LM Studio **Windows**; w WSL zmień dwie zmienne `GEMMA` i `GEMMA_MMPROJ` na odpowiednie ścieżki `/mnt/c/...`.

### 2. Uruchom Qwena z MTP 2

```bash
"$LLAMA_BIN/llama-server" -m "$QWEN" -c 32768 -np 1 -ngl 99 -fa on -ctk q8_0 -ctv q8_0 --spec-type draft-mtp --spec-draft-n-max 2 --jinja --host 127.0.0.1 --port 8080
```

### 3. Uruchom Gemmę do kodu i tekstu

```bash
"$LLAMA_BIN/llama-server" -m "$GEMMA" -c 32768 -np 1 -ngl 99 -fa on -ctk q8_0 -ctv q8_0 --jinja --host 127.0.0.1 --port 8080
```

### 4. Uruchom Gemmę z vision

```bash
"$LLAMA_BIN/llama-server" -m "$GEMMA" --mmproj "$GEMMA_MMPROJ" -c 32768 -np 1 -ngl 99 -fa on -ctk q8_0 -ctv q8_0 -b 4096 -ub 4096 --reasoning off --jinja --host 127.0.0.1 --port 8080
```

### 5. Uruchom Muse z DFlash 16

```bash
"$LLAMA_BIN/llama-server" -m "$MUSE" -md "$DFLASH" -ngld 99 --spec-draft-n-max 16 -c 32768 -np 1 -ngl 99 -fa on -ctk q8_0 -ctv q8_0 --jinja --host 127.0.0.1 --port 8080
```

### 6. Sprawdź serwer i zadaj pytanie

```bash
curl -sS http://127.0.0.1:8080/health
curl -sS http://127.0.0.1:8080/v1/models
curl -sS http://127.0.0.1:8080/v1/chat/completions -H 'Content-Type: application/json' -d '{"messages":[{"role":"user","content":"Napisz krótki program Hello World w Pythonie."}],"max_tokens":256,"stream":false}'
```

### 7. Powtórz krótki benchmark każdego modelu

```bash
"$LLAMA_BIN/llama-bench" -m "$QWEN" -p 512,2048 -n 128 -r 2 -ngl 99 -fa on -ctk q8_0 -ctv q8_0
"$LLAMA_BIN/llama-bench" -m "$GEMMA" -p 512,2048 -n 128 -r 2 -ngl 99 -fa on -ctk q8_0 -ctv q8_0
"$LLAMA_BIN/llama-bench" -m "$MUSE" -p 512,2048 -n 128 -r 2 -ngl 99 -fa on -ctk q8_0 -ctv q8_0
```

### 8. Długi kontekst: przykład Qwena 128k

```bash
"$LLAMA_BIN/llama-server" -m "$QWEN" -c 131072 -np 1 -ngl 99 -fa on -ctk q4_0 -ctv q4_0 --spec-type draft-mtp --spec-draft-n-max 2 --jinja --host 127.0.0.1 --port 8080
```

To tylko ustawia pojemność 128k. Jeżeli chcesz zmierzyć szybkość **po zapełnieniu** 128k, użyj `llama-bench` z `-d 131072`; taki test długo trwa i zużywa dużo VRAM:

```bash
"$LLAMA_BIN/llama-bench" -m "$QWEN" -d 131072 -p 512 -n 64 -r 1 -ngl 99 -fa on -ctk q4_0 -ctv q4_0
```

### 9. Playwright → zrzut ekranu → lokalna Gemma vision

W drugim terminalu uruchom Gemmę z punktu 4, a w kolejnym `npm start` dla ThreadShelf na porcie 3000. Zainstaluj przeglądarkę Playwright, jeśli jeszcze jej nie ma: `npx playwright install chromium`. Poniższy przykład otwiera lokalną stronę, wysyła zrzut tylko do `127.0.0.1` i wypisuje opis. Zmień `TARGET_URL` na swoją stronę, gdy zechcesz:

```bash
TARGET_URL=http://127.0.0.1:3000 node --input-type=module <<'JS'
import { chromium } from '@playwright/test';

const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.goto(process.env.TARGET_URL, { waitUntil: 'domcontentloaded' });
  const png = await page.screenshot({ type: 'png', scale: 'css' });
  const response = await fetch('http://127.0.0.1:8080/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      messages: [{ role: 'user', content: [
        { type: 'text', text: 'Opisz, co widać na stronie i wskaż główny przycisk.' },
        { type: 'image_url', image_url: { url: `data:image/png;base64,${png.toString('base64')}` } },
      ] }],
      max_tokens: 256,
      stream: false,
    }),
  });
  if (!response.ok) throw new Error(`API HTTP ${response.status}: ${await response.text()}`);
  const result = await response.json();
  console.log(result.choices[0].message.content);
} finally {
  await browser.close();
}
JS
```
