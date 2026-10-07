SELECT  
	f.FleetName
	,substr(FleetName,1,instr(FleetName,' 2.5 ')) || '3.2 ' || substr(FleetName,instr(FleetName,' 2.5 ')+5)
	,	* FROM	FCT_Fleet as f
--update FCT_fleet set FleetName = substr(FleetName,1,instr(FleetName,' 2.5 ')) || '3.2 ' || substr(FleetName,instr(FleetName,' 2.5 ')+5)
WHERE
	FleetName like '% 1.25'
AND
	RaceID = 607
/*
AND
	FleetName not like '%SPIN'
AND
	FleetName not like '% x %'
*/