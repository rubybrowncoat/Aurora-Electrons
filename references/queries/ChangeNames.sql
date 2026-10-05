SELECT
	*
	,instr(dnt.Name,' ')
	,substr(dnt.Name,1,instr(dnt.Name,' ')-1)
FROM
	DIM_NamingTheme as dnt
WHERE
	dnt.Name like '% County'
	
/*
update DIM_NamingTheme 
set Name = substr(Name,1,instr(Name,' ')-1)
where Name like '% County'
*/