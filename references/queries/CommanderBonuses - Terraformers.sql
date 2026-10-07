with x as (
	select
		(select max(RaceID) as RaceID from FCT_Race where NPR = 0) as RaceID
		,(select max(GameID) as GameID from FCT_Game) as GameID
)
SELECT
	_flt.FleetName
	,_ship.ShipName
	,_class.Terraformers
	,_cmdr.Name as CommanderName
	,ifnull(_cmdrbon.BonusValue,1.0) as CmdrBonus
	,cast(20 + round((g.GameTime - _cmdr.CareerStart) / 86400 / 365,0) as int) as CmdrAge
	,_cmdr.HealthRisk
	,_cmdr.PromotionScore
	
-- select *		
FROM
	FCT_Fleet as _flt
inner JOIN x on x.RaceID = _flt.RaceID
inner JOIN FCT_Game as g on g.GameID = x.GameID
inner JOIN
	FCT_Ship as _ship
on
	_ship.FleetID = _flt.FleetID
inner JOIN
	FCT_ShipClass as _class
on
	_class.ShipClassID = _ship.ShipClassID
left JOIN
	FCT_Commander as _cmdr
on
	_cmdr.CommandID = _ship.ShipID
AND
	_cmdr.CommanderType = 0
left JOIN
	FCT_CommanderBonuses as _cmdrbon
on
	_cmdrbon.CommanderID = _cmdr.CommanderID
AND
	_cmdrbon.BonusID = 9 --terraforming
WHERE
	_class.Terraformers > 0	
order by
	_class.Terraformers desc
	,ifnull(_cmdrbon.BonusValue,1.0) desc
	,_ship.ShipName