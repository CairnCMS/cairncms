# Material Symbols

`material-symbols.woff2` and `app/src/interfaces/select-icon/icons.json`
must be updated together. If the picker lists a ligature that the
shipped font doesn't contain, the icon renders as the raw text of its
name.

The shipped font is a static 300-weight build, so `v-icon`'s `filled`
prop currently has no visual effect.
