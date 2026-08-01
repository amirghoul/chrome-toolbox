# chrome-toolbox

Collection d'extensions Chrome développées pour mes besoins personnels.

## Structure

Chaque extension vit dans son propre dossier à la racine, indépendant des autres :

```
chrome-toolbox/
├── commun/           # Code réutilisable partagé entre plusieurs extensions
├── nom-extension-1/  # Une extension = un dossier = son propre manifest.json
├── nom-extension-2/
└── ...
```

- Un dossier = une extension Chrome autonome (son propre `manifest.json`, ses propres fichiers).
- `commun/` regroupe les utilitaires, styles ou composants réutilisés par la majorité des extensions (pas de dépendance obligatoire, chaque extension pioche ce dont elle a besoin).
