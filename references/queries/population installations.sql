select 
PopName
,_pop.PopulationID
	,_pop.Duranium as Stock
	,_pop.LastDuranium as last	
	,_pop.*
	FROM FCT_Population as _pop 
	
	
inner JOIN (select max(RaceID) as RaceID from FCT_Race where NPR = 0) as CurrentRace on CurrentRace.RaceID = _pop.RaceID
order by PopName


select * from FCT_PopulationInstallations where PopID in(4420, 4493)