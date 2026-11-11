# Community Aurora SQL queries

A collection of SQL scripts for Aurora C# saves that accompanies `references/aurcalcs/Aur_Calcs260.xlsx`, imported from skoormit, including the non-SQL file `excel/survey.txt`. Permission from skoormit to reshare it is established. It is kept here as an optional local reference for features and game maths to port into Aurora Electrons. The files are not a build input. They are unchanged from the source, apart from line endings normalized by `.gitattributes`.

No licence for the collection is granted here, and Aurora Electrons' MIT licence does not cover it. Removing these files from the index keeps the working copies and does not rewrite or erase Git history.

**Don't run these against a save you care about.** At least 37 of them write to the database (`UPDATE`, `DELETE`, `INSERT`, `CREATE VIEW`): they rename fleets, purge history, move cargo, create views, and so on. Only the read queries are candidates for porting, rewritten as inline queries scoped by `GameID` and `RaceID`. To experiment, use a copy of the save. Aurora Electrons reads the save except the confirmed Galaxy Map Save Positions, which writes the moved systems' coordinates, rounded to whole units. Do that with the game closed, or load the save again in the game before playing on. That write is not one of these scripts.

## Layout

| Folder | Contents |
|---|---|
| `excel/` | The `SELECT` bodies behind the workbook's `vw_*` views (some still prefixed by commented-out `create view`). Several are older than the workbook, and some views it uses (`vw_tfplan`, `vw_Species`, `vw_shipClasses`, the fuel/MSP fairy views…) have no file here. |
| `views/` | Small helper views (`vw_const`, `vw_popname`) the other queries join against. |
| `Yearly/` | A numbered checklist the author runs periodically: idle fleets, stations needing fuel or supplies, colonies needing a governor, orbital miners not mining, prototypes not being researched… Mostly read-only reports, plus a few clean-up scripts (`01`, `01c`). |
| Root | One-off reports (commanders with bonuses, inbound cargo by population, ship component percentages, shipyards, wealth use…) and maintenance scripts. |
| `Quick/`, `investigations/` | Small ad-hoc reports. |
| `utility/` | Schema helpers: row counts for every table, finding columns or views by name, table clean-up. |
| `Mods/` | Save edits (for example, inserting rare trade goods). |
| `conversions/` | Save migrations between Aurora versions (1.10 → 1.11, 2.6 → 2.7). Large, and write-only. |
