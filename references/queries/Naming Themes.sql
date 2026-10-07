select * from DIM_NamingTheme as nt
inner join DIM_NamingThemeTypes as ntt
on ntt.ThemeID = nt.NameThemeID
where Description like '%Animals%'
order by nt.Name