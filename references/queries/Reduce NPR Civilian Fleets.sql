
--select * 
--delete 
from FCT_Ship where FleetID in (select f.FleetID from FCT_Fleet as f where f.RaceID = 780 and f.CivilianFunction = 1 and f.FleetID < 132731)

--delete from FCT_Fleet where RaceID = 602 and CivilianFunction = 1 and FleetID < 132731


select * from FCT_Fleet where RaceID = 617 and CivilianFunction = 2 and FleetID not in (select FleetID from FCT_MoveOrders) order by FleetID
--select * 
--delete
from FCT_Ship where FleetID in (select FleetID from FCT_Fleet where RaceID = 617 and CivilianFunction = 2 and FleetID not in (select FleetID from FCT_MoveOrders) and FleetID <= 209194)


--delete from FCT_Fleet where RaceID = 602 and CivilianFunction = 2 and FleetID < 132803

select * from FCT_Fleet where FleetID not in (select FleetID from FCT_Ship) and RaceID in (615,616,617)

--select * 
--DELETE
from FCT_Ship where FleetID in (select f.FleetID from FCT_Fleet as f where f.RaceID IN (615,616,617) and f.CivilianFunction = 4)


delete from FCT_Fleet where RaceID IN (615,616,617) and CivilianFunction = 4


delete from FCT_ShipCargo where ShipID not in (select ShipID from fct_ship)
delete from FCT_ShipHistory where ShipID not in (select ShipID from fct_ship)


delete from FCT_MoveOrders where FleetID not in (select FleetID from FCT_Fleet)
delete from FCT_FleetHistory where FleetID not in (select FleetID from FCT_Fleet)

select * from FCT_Commander
--update FCT_Commander set CommandID = 0, CommandType = 0 
where CommandType = 1 and CommandID not in (select ShipID from FCT_Ship)