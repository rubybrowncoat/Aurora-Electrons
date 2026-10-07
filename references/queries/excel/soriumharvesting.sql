--drop view vw_sorharv;
--create view vw_sorharv as


SELECT
	p.PopName
	,upper(substr(rss.Name,1,3)) as Sys
	,s.ShipName
	,sc.Harvesters
	,ifnull(c.Name,'') as Commander
	,ifnull(cb.BonusValue,1.0) as Bonus
	,ifnull(fm.Accessibility,'') as SorAcc
	,ifnull(fm.Amount/1000,'') as SorAmtK
	--, r.FuelProduction * sc.Harvesters as ShipProduction, sc.*,c.*
FROM
	(select max(RaceID) as RaceID from FCT_Race where NPR = 0) as CurrentRace
inner JOIN
	FCT_Race as r
on
	r.RaceID = CurrentRace.RaceID
inner JOIN
	FCT_Ship as s
on
	s.RaceID = CurrentRace.RaceID
inner JOIN
	FCT_Fleet as f
on
	f.FleetID = s.FleetID
left JOIN
	FCT_SystemBody as sysbod
on
	sysbod.SystemBodyID = f.OrbitBodyID
left JOIN
	FCT_Population as p
on
	p.SystemBodyID = sysbod.SystemBodyID
left join
	FCT_RaceSysSurvey as rss
on
	rss.SystemID = sysbod.SystemID
AND
	rss.RaceID = CurrentRace.RaceID
left JOIN
	FCT_MineralDeposit as fm
on
	fm.SystemBodyID = f.OrbitBodyID
AND
	fm.MaterialID = 8 --sorium
inner JOIN
	FCT_ShipClass as sc
on
	sc.ShipClassID = s.ShipClassID
left JOIN
	FCT_Commander as c
on
	c.CommandID = s.ShipID
AND
	c.CommanderType = 0
AND
	c.CommandType = 1
AND
	c.RaceID = CurrentRace.RaceID
left JOIN
	FCT_CommanderBonuses as cb
on
	cb.CommanderID = c.CommanderID
AND
	cb.BonusID = 6 --mining bonus	
where 
	sc.Harvesters > 0
AND	
	sc.ClassShippingLineID = 0	
order by 
	sc.Harvesters desc
	,ifnull(cb.BonusValue,1.0) desc