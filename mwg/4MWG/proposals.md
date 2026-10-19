1. MwlRuntime.loadLeaders (mwg/dist/mwl/runtime.js, vers la ligne 581) : si [side] leader= nomme l'id d'une unité déjà déclarée, il crée quand même une unité fantôme de type <leader> sur la case de départ du camp. Cela a fait planter une dizaine de scénarios (« unknown unit type "Kalenz" »). Il devrait ne rien créer quand le nom correspond à une unité existante, et ne spawner que si la valeur est un type connu. Le port contourne ce défaut dans main.ts.
2. [while] : le runtime ne lit que des enfants [condition]. Les conditions composées ([and], [or], [not], [have_location]) ne sont pas exprimables. Il faudrait un [condition] à arbre imbriqué, ou le support de filter_condition. Le port passe par condition=hook avec tree=, ce qui exige d'étendre le schéma côté port.
3. Garde-fous de boucle : while s'arrête à 1000 itérations sans erreur ni trace. Il faudrait une trace ou un avertissement quand le plafond est atteint, et un coût d'itération borné.
4. Formules de variables dans les actions : une valeur comme size / ($turn_limit - $turn_number) n'est pas évaluée par set_variable. Le framework devrait offrir une évaluation d'expressions avec interpolation $var et des variables contextuelles injectables.
5. Génération de cartes de cavernes : générateur déterministe (chambres, passages, jagged, windiness, villages, marqueurs de départ). Il vit dans src/simulation/cave-generator.ts et pourrait devenir une brique générique du framework.
6. Schéma : condition devrait accepter des attributs de prédicat libres (tree, etc.), pour éviter les extensions de schéma côté port.
7. Dépendance fengari (Lua) : elle appelle require('os').platform() au chargement et casse le bundle navigateur. Le framework devrait fournir un shim os ou une version de fengari compatible navigateur. Le port a ajouté src/shims/os.ts et un alias vite.
8. Outillage de vérification : tools/verify-all-scenarios.mjs (tous les scénarios dans un seul Chrome headless, avec un bot qui joue les deux camps) est générique. Il aurait sa place dans le framework, ainsi qu'une API de contrôle de la scène pour les tests (enterScenario, finishTurn, advanceDialogue aujourd'hui privés).
9. Widgets de HUD génériques : barre de statut à icônes, panneau latéral avec minimap, barres de PV et d'XP. Le port les a écrits à la main dans src/ui/hud.ts.
10. Résolution des variantes d'images (@V sans liste de variations) : ce défaut est propre à Wesnoth, donc il reste côté port.

État après adoption de MWG 0.33.0 (2026-10-10) :

- 1 : corrigé en 0.32, contournement du port supprimé.
- 2 et 6 : expressions de prédicats et attributs libres disponibles en 0.33 ; extension locale `condition.tree` supprimée. Les filtres WML complexes restent dans le port.
- 3 : trace `while_limit` et option `on_limit=error` disponibles et conservées dans la trace du port.
- 4 : les formules WML restent évaluées par les hooks du port pour préserver leur sémantique.
- 5 : générateur livré, mais sur grille carrée ; le port garde ses six voisins hexagonaux et son flux aléatoire.
- 7 : dépendance explicite `@datamoc/fengari` adoptée. Les attributs Lua `<close>` et `<const>` restent rejetés par son parseur ; le contournement demeure. Le shim navigateur reste nécessaire tant que le build en dépend.
- 8 : première moitié livrée, API `__WESNOTH__.controls` adoptée, utilisée par le contrôle navigateur. La vérification multi-scénarios reste un outil du port.
- 9 : widgets non livrés dans cette version.
- 10 : propre à Wesnoth, inchangé.

Les nouveautés squelette, SVG et génération de monde ont été examinées : les données réelles utilisées par le port reposent sur des frames PNG et des cartes Wesnoth, elles ne justifient pas ces substitutions.

État après adoption de fengari 0.5.4 avec MWG 0.35.0 (2026-10-11) :

- 7 : le paquet fournit maintenant sa configuration navigateur et ne demande plus `require('os').platform()` au chargement. Le shim `src/shims/os.ts` et son alias Vite sont supprimés. `<const>`, `<close>` et `coroutine.close` fonctionnent nativement depuis fengari 0.3 ; le texte de l'état 0.33 ci-dessus est historique.
- Les erreurs de budget prises dans une coroutine restent des échecs de l'appel hôte, et la fermeture d'une coroutine reçoit son propre budget. Le contournement local de la première erreur est supprimé au profit de `FengariVm.protect`.
- Le traducteur conserve la sémantique Lua de `a or b`, notamment pour `false`, `0` et la chaîne vide, et évalue son opérande gauche une seule fois. La traduction des campagnes reste un outil de revue, pas le code exécuté par le jeu.

État après adoption de MWG 0.35.1 (2026-10-11) : la dépendance du framework impose elle-même fengari ^0.5.4. Le port adopte l'option `print: 'native'` pour éviter une initialisation redondante, les helpers de fichiers du VM et son générateur aléatoire, avec conservation du flux enregistré et des diagnostics. Les conversions de tables WML et le chargeur Wesnoth restent spécifiques au port.

État après adoption de MWG 0.36.0 (2026-10-12) : le framework remplace fengari par `@datamoc/pyroeis` ^0.6.0 (même VM Lua 5.4.6, autre nom de paquet), renomme le sous-chemin `mwl/fengari` en `mwl/pyroeis`, les factories `createFengari*` en `createPyroeis*` et les types `Fengari*` en `Pyroeis*`. Le port suit : dépendance directe `@datamoc/pyroeis` ^0.6.0, pont Wesnoth (`src/scripting/lua-vm.ts`) sur `PyroeisVm`, hôte des conditions `[lua]` sur `createPyroeisScriptHost`, traducteur sur `mwg/mwl/pyroeis`, test renommé `tests/pyroeis-upgrade.test.ts`. Le point 7 est donc clos : un seul VM partagé, toujours sans shim.

Surface du VM examinée et non adoptée : `PyroeisVm.compile` (compilation numérique Lua vers JavaScript) est refusée tant que `limits` est actif et le port exécute toujours son noyau borné ; `limits.timeMs` n'est pas activé, les plafonds d'instructions et d'allocation bornant déjà la génération de carte, tandis qu'une échéance en temps réel la rendrait dépendante de la vitesse de la machine ; `preserveFloats` sert à des floats, que la WML ne lit pas ; `libs`/`remove`/`sandbox` sont ignorés, le VM du port faisant tourner le noyau de confiance du moteur, qui a besoin de `debug`, `os` et `load`.
