SELECT
	f.FleetName
	,s.ShipName
	,s.CurrentCrew
	,sc.Crew
	,sc.Crew - s.CurrentCrew as MissingCrew
	,round(100.0*s.CurrentCrew/sc.Crew,3)  as CrewPct
	
FROM
	vw_const as c
inner join fct_fleet as f on f.RaceID = c.RaceID
inner join fct_ship as s on s.FleetID = f.FleetID
inner join FCT_ShipClass as sc on sc.ShipClassID = s.ShipClassID
where s.CurrentCrew < sc.Crew
and s.ShipName not like 'XXX TIMER XXX%'
order by 
	6
	,5 desc
	,f.FleetName
	